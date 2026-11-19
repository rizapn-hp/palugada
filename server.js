"use strict";

const express = require('express');
const fetch = require('node-fetch');
const URL = require('url');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { execFile } = require('child_process');

const YTDLP_BIN = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : '/home/rizapn/.local/bin/yt-dlp';

const videoCache = new Map();
function getStreamInfo(videoId) {
    if (!videoId) return Promise.resolve(null);
    if (videoCache.has(videoId)) {
        const cached = videoCache.get(videoId);
        if (Date.now() - cached.time < 3600 * 1000) {
            return Promise.resolve(cached.data);
        }
    }
    return new Promise((resolve) => {
        execFile(YTDLP_BIN, [
            '-j',
            '--no-warnings',
            `https://www.youtube.com/watch?v=${videoId}`
        ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err || !stdout) {
                console.error(`[STREAM-EXTRACT-FAIL] ${videoId}:`, err ? err.message : 'no stdout');
                return resolve(null);
            }
            try {
                const d = JSON.parse(stdout);
                const hlsFormat = d.formats ? d.formats.find(f => f.manifest_url && f.manifest_url.includes('m3u8')) : null;
                const hlsUrl = hlsFormat ? hlsFormat.manifest_url : null;
                const adaptiveFormats = (d.formats || [])
                    .filter(f => f.protocol === 'https' && f.url && (f.vcodec !== 'none' || f.acodec !== 'none') && (!f.vcodec || !f.vcodec.startsWith('av01')))
                    .map(f => ({
                        itag: parseInt(f.format_id, 10) || 134,
                        url: f.url,
                        mimeType: f.vcodec !== 'none' 
                            ? `${f.ext === 'mp4' ? 'video/mp4' : 'video/webm'}; codecs="${f.vcodec}"`
                            : `${f.ext === 'm4a' || f.ext === 'mp4' ? 'audio/mp4' : 'audio/webm'}; codecs="${f.acodec}"`,
                        bitrate: Math.round((f.tbr || f.abr || 1000) * 1000),
                        width: f.width || undefined,
                        height: f.height || undefined,
                        fps: f.fps || undefined,
                        quality: f.format_note || 'medium',
                        qualityLabel: f.height ? `${f.height}p` : undefined,
                        approxDurationMs: `${Math.round((d.duration || 0) * 1000)}`
                    }));
                const res = { hlsUrl, adaptiveFormats, title: d.title, duration: d.duration };
                videoCache.set(videoId, { time: Date.now(), data: res });
                console.log(`[STREAM-EXTRACT-OK] ${videoId}: ${adaptiveFormats.length} formats, HLS=${!!hlsUrl}`);
                resolve(res);
            } catch(e) {
                resolve(null);
            }
        });
    });
}

const app = express();
const HTTP_PORT = 8100;
const HTTPS_PORT = 8101;

app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (origin !== '*') {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE, HEAD');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Serve local TizenTube userScript
app.get('/tizentube.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, 'userScript.js'));
});

// Client logging endpoint
app.all('/tvlog', (req, res) => {
    try {
        console.log(`[CLIENT-LOG] ${decodeURIComponent(req.originalUrl || req.url)}`);
    } catch(e) {
        console.log(`[CLIENT-LOG] raw url=${req.originalUrl || req.url}`);
    }
    const clientOrigin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', clientOrigin);
    if (clientOrigin !== '*') {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.send('ok');
});

// Health check
app.get('/tizentube/status', (req, res) => {
    res.json({ status: 'ok', version: '2.1.1', platform: 'Coolita OS' });
});

// Root redirect to /tv
app.get('/', (req, res) => {
    res.redirect('/tv');
});

app.use(async (req, res) => {
    console.log(`[REQ from ${req.socket.remoteAddress}] ${req.method} ${req.url}`);
    const isCorsBypass = req.path.indexOf('/cors-bypass/') === 0;

    const cleanUrl = req.url.replace(/\.v[0-9]+\.js/g, '.js');
    let targetUrl;
    if (isCorsBypass) {
        let rawTarget = cleanUrl.substring('/cors-bypass/'.length);
        if (rawTarget.indexOf('http://') !== 0 && rawTarget.indexOf('https://') !== 0) {
            rawTarget = 'https://' + rawTarget;
        }
        targetUrl = rawTarget;
    } else {
        targetUrl = `https://www.youtube.com${cleanUrl}`;
    }

    try {
        const parsedUrl = URL.parse(targetUrl);
        if (!parsedUrl.hostname || parsedUrl.hostname.startsWith('.') || parsedUrl.hostname === 'googlevideo.com') {
            return res.status(404).send('Invalid host');
        }
    } catch(e) {
        return res.status(400).send('Malformed URL');
    }

    const isEncrypted = Boolean((req.socket && req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https');
    const proto = isEncrypted ? 'https' : 'http';
    const hostHeader = req.headers['host'] || `127.0.0.1:${isEncrypted ? HTTPS_PORT : HTTP_PORT}`;
    const proxyHost = `${proto}://${hostHeader}`;
    const proxyPrefix = `${proxyHost}/cors-bypass/`;
    const proxyPrefixEscaped = proxyPrefix.replace(/\//g, '\\/');

    const headers = {};
    for (const key in req.headers) {
        if (Object.prototype.hasOwnProperty.call(req.headers, key)) {
            if (key === 'cookie') {
                const cookieStr = req.headers[key]
                    .replace(/__LocalSecure-/g, '__Secure-')
                    .replace(/__LocalHost-/g, '__Host-');
                const cookieMap = {};
                cookieStr.split(';').forEach(part => {
                    const eq = part.indexOf('=');
                    if (eq !== -1) {
                        const k = part.substring(0, eq).trim();
                        const v = part.substring(eq + 1).trim();
                        if (k) cookieMap[k] = v;
                    }
                });
                headers[key] = Object.keys(cookieMap).map(k => `${k}=${cookieMap[k]}`).join('; ');
                continue;
            }
            if (key !== 'host') {
                headers[key] = req.headers[key];
            }
        }
    }

    delete headers['if-none-match'];
    delete headers['if-modified-since'];

    const parsedTarget = URL.parse(targetUrl);
    headers['host'] = parsedTarget.host;

    if (!isCorsBypass) {
        headers['origin'] = 'https://www.youtube.com';
        headers['referer'] = 'https://www.youtube.com/tv';
    } else {
        delete headers['referer'];
        headers['origin'] = 'https://www.youtube.com';
    }

    // Force Smart TV User-Agent so YouTube TV never redirects to desktop www.youtube.com
    headers['user-agent'] = 'Mozilla/5.0 (Smart-TV; Linux; Coolita 3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.114 TV Safari/537.36 Coolita OS QJY/3.0 NETRANGEMMH';

    const hasBody = ['POST', 'PUT', 'PATCH'].indexOf(req.method) !== -1;
    let bodyBuffer = undefined;
    let reqVideoId = null;

    if (hasBody) {
        bodyBuffer = await new Promise((resolve) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', () => resolve(Buffer.alloc(0)));
        });
        if (req.url.indexOf('/youtubei/v1/player') !== -1 && bodyBuffer && bodyBuffer.length > 0) {
            try {
                const parsedReq = JSON.parse(bodyBuffer.toString('utf8'));
                reqVideoId = parsedReq.videoId;
                console.log(`[PLAYER-REQ] Extracted videoId: ${reqVideoId}`);
                if (parsedReq.playbackContext && parsedReq.playbackContext.contentPlaybackContext) {
                    parsedReq.playbackContext.contentPlaybackContext.isLivingRoomDeeplink = false;
                    parsedReq.playbackContext.contentPlaybackContext.referer = 'https://www.youtube.com/tv';
                }
                const newBody = JSON.stringify(parsedReq);
                bodyBuffer = Buffer.from(newBody, 'utf8');
                headers['content-length'] = `${bodyBuffer.length}`;
            } catch(e) {}
        }
        if (req.url.indexOf('/api/stats/qoe') !== -1 && bodyBuffer && bodyBuffer.length > 0) {
            console.log(`[QOE-BODY] ${bodyBuffer.toString('utf8')}`);
        }
    }

    const fetchOptions = {
        method: req.method,
        headers: headers,
        body: bodyBuffer,
        redirect: 'manual'
    };

    fetch(targetUrl, fetchOptions)
        .then((response) => {
            res.status(response.status);

            const contentType = response.headers.get('content-type') || '';
            const isText = (
                contentType.indexOf('text/html') !== -1 ||
                contentType.indexOf('application/json') !== -1 ||
                contentType.indexOf('javascript') !== -1 ||
                contentType.indexOf('text/css') !== -1 ||
                contentType.indexOf('text/plain') !== -1 ||
                req.url.indexOf('.js') !== -1
            );

            const headerKeys = response.headers.raw();
            for (const key in headerKeys) {
                if (Object.prototype.hasOwnProperty.call(headerKeys, key)) {
                    const lowerKey = key.toLowerCase();
                    const skipHeaders = [
                        'content-security-policy',
                        'content-security-policy-report-only',
                        'x-frame-options',
                        'strict-transport-security',
                        'content-encoding',
                        'access-control-allow-origin',
                        'access-control-allow-credentials',
                        'alt-svc',
                        'alternate-protocol',
                        'transfer-encoding',
                        'connection',
                        'keep-alive'
                    ];
                    if (isCorsBypass) skipHeaders.push('access-control-allow-origin');
                    if (isText) {
                        skipHeaders.push('content-length');
                        skipHeaders.push('transfer-encoding');
                        skipHeaders.push('etag');
                        skipHeaders.push('last-modified');
                    }
                    if (skipHeaders.indexOf(lowerKey) !== -1) continue;

                    const value = response.headers.get(key);
                    if (lowerKey === 'location') {
                        let loc = value;
                        if (loc && (loc.indexOf('.googlevideo.com') !== -1 || loc.indexOf('.c.youtube.com') !== -1)) {
                            if (loc.indexOf('/cors-bypass/') === -1) {
                                loc = `${proxyPrefix}${loc}`;
                            }
                        }
                        res.setHeader('Location', loc);
                        continue;
                    }
                    if (lowerKey === 'set-cookie') {
                        const rawCookies = headerKeys[key];
                        if (Array.isArray(rawCookies)) {
                            const modifiedCookies = rawCookies.map(cookieStr => {
                                return cookieStr
                                    .replace(/^__Secure-/i, '__LocalSecure-')
                                    .replace(/^__Host-/i, '__LocalHost-')
                                    .replace(/Domain=[^;]+/i, '')
                                    .replace(/;\s*Secure/i, '')
                                    .replace(/;\s*SameSite=None/i, '')
                                    .replace(/Path=[^;]+/i, '')
                                    .replace(/;\s*;/g, ';')
                                    .replace(/;\s*$/, '') + '; Path=/';
                            });
                            res.setHeader('Set-Cookie', modifiedCookies);
                            continue;
                        }
                    }

                    res.setHeader(key, value);
                }
            }

            const clientOrigin = req.headers.origin || '*';
            res.setHeader('Access-Control-Allow-Origin', clientOrigin);
            if (clientOrigin !== '*') {
                res.setHeader('Access-Control-Allow-Credentials', 'true');
            }
            if (isText) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            }

            // If it is a video/audio stream or binary data, pipe immediately!
            if (isCorsBypass && (
                contentType.indexOf('video') !== -1 ||
                contentType.indexOf('audio') !== -1 ||
                contentType.indexOf('octet-stream') !== -1 ||
                contentType.indexOf('vnd.yt-ump') !== -1 ||
                contentType.indexOf('protobuf') !== -1
            )) {
                console.log(`[STREAM] Piped stream (${contentType}) ${targetUrl.substring(0, 80)}...`);
                if (response.body) {
                    response.body.pipe(res);
                } else {
                    res.end();
                }
                return;
            }

            if (isText) {

                return response.text().then(async (text) => {
                    // Raw passthrough for initplayback so client parses valid googlevideo host
                    if (req.url.indexOf('/initplayback') !== -1) {
                        return res.send(text);
                    }

                    if (req.url.indexOf('/tv') === 0 && req.url.indexOf('/tv_config') === -1) {
                        const debugTag = '<style>video{background:transparent !important;}</style><script>' +
                            'try{if(!localStorage.getItem("ytaf-configuration")){localStorage.setItem("ytaf-configuration",JSON.stringify({focusContainerColor:"#0f0f0f",routeColor:"#0f0f0f"}));}}catch(e){}' +
                            'window.queuedVideos=window.queuedVideos||{videos:[],lastVideoId:null};' +
                            'function _s(m){try{new Image().src="/tvlog?log="+encodeURIComponent(m);}catch(e){}}' +
                            '_s("PAGE_INIT: "+window.location.href);' +
                            'window.onerror=function(m,u,l){_s("ERR: "+m+" @ "+u+":"+l);};' +
                            'var _oe=console.error;console.error=function(){_oe.apply(console,arguments);_s("C_ERR: "+[].slice.call(arguments).join(" "));};' +
                            'var _ow=console.warn;console.warn=function(){_ow.apply(console,arguments);var s=[].slice.call(arguments).join(" ");if(s.indexOf("HTML5")!==-1||s.indexOf("DRM")!==-1||s.indexOf("error")!==-1||s.indexOf("Error")!==-1||s.indexOf("reject")!==-1||s.indexOf("fatal")!==-1){_s("C_WARN: "+s);}};' +
                            'window.addEventListener("unhandledrejection",function(e){_s("REJECT: "+(e.reason?(e.reason.stack||e.reason.message||e.reason):"unknown"));});' +
                            'document.addEventListener("error",function(e){if(e.target&&e.target.tagName==="VIDEO"){var er=e.target.error;_s("V_ERR: code="+(er?er.code:"null")+" msg="+(er?er.message:""));}},true);' +
                            'document.addEventListener("play",function(e){if(e.target&&e.target.tagName==="VIDEO"){_s("V_PLAY: "+(e.target.currentSrc||"")+" w="+e.target.videoWidth+" h="+e.target.videoHeight);}},true);' +
                            'document.addEventListener("playing",function(e){if(e.target&&e.target.tagName==="VIDEO"){_s("V_PLAYING: time="+e.target.currentTime+" res="+e.target.videoWidth+"x"+e.target.videoHeight);}},true);' +
                            'document.addEventListener("waiting",function(e){if(e.target&&e.target.tagName==="VIDEO"){_s("V_WAITING (buffer stall)");}},true);' +
                            'function _hb(e){var c=e?(e.keyCode||e.which):0;var k=e?(e.key||""):"";_s("REMOTE_KEY: code="+c+" key="+k);if(c===4||c===10009||c===461||c===8||k==="Back"||k==="GoBack"||k==="BrowserBack"){try{if(e.preventDefault)e.preventDefault();}catch(x){}try{if(e.stopImmediatePropagation)e.stopImmediatePropagation();}catch(x){}var done=false;try{for(var i in window._yttv){if(window._yttv[i]&&window._yttv[i].instance&&window._yttv[i].instance.resolveCommand){window._yttv[i].instance.resolveCommand({signalAction:{signal:"HISTORY_BACK"}});done=true;break;}}}catch(x){}if(!done){try{var ev=new KeyboardEvent("keydown",{key:"Escape",code:"Escape",keyCode:27,which:27,bubbles:true,cancelable:true});Object.defineProperty(ev,"keyCode",{value:27});Object.defineProperty(ev,"which",{value:27});Object.defineProperty(ev,"key",{value:"Escape"});window.dispatchEvent(ev);document.dispatchEvent(ev);if(document.activeElement&&document.activeElement!==document.body)document.activeElement.dispatchEvent(ev);}catch(x){}setTimeout(function(){if(window.location.hash&&window.location.hash.indexOf("watch")!==-1){window.location.hash="#/";}},350);}return false;}}' +
                            'window.addEventListener("keydown",_hb,true);' +
                            'window.addEventListener("keyup",function(e){var c=e?(e.keyCode||e.which):0;var k=e?(e.key||""):"";if(c===4||c===10009||c===461||c===8||k==="Back"||k==="GoBack"||k==="BrowserBack"){try{e.preventDefault();e.stopImmediatePropagation();}catch(x){}}},true);' +
                            'window.onAndroidKeyEvent=function(c,n,s){_s("ANDROID_KEY: "+c+" name="+n);if(c===4||c===111||n==="Back"||n==="KEYCODE_BACK"){_hb({keyCode:c,key:n});}};' +
                            'try{var _ms=MediaSource.isTypeSupported.bind(MediaSource);MediaSource.isTypeSupported=function(t){if(!t)return false;if(t.indexOf("av01")!==-1||t.indexOf("av1")!==-1)return false;return _ms(t);};}catch(e){}' +
                            'try{var _cpt=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(t){if(!t)return"";if(t.indexOf("av01")!==-1||t.indexOf("av1")!==-1)return"";return _cpt.call(this,t);};}catch(e){}' +
                            'try{Object.defineProperty(document,"referrer",{get:function(){return"https://www.youtube.com/tv";},configurable:true});}catch(e){}' +
                            'try{var _rejDrm=function(k,c){_s("DRM_BYPASS: "+k);return Promise.reject(new Error("Unsupported keySystem"));};navigator.requestMediaKeySystemAccess=_rejDrm;Object.defineProperty(navigator,"requestMediaKeySystemAccess",{value:_rejDrm,configurable:true,writable:true});}catch(e){}' +
                            'try{var _jp=JSON.parse;JSON.parse=function(s){if(s===undefined||s==="undefined"||s===null||s==="null")return{};var d=_jp.apply(this,arguments);if(d&&typeof d==="object"){if(d.adPlacements)d.adPlacements=[];if(d.playerAds)d.playerAds=false;if(d.adSlots)d.adSlots=[];}return d;};}catch(e){}' +
                            'try{Object.defineProperty(navigator,"userAgent",{get:function(){return"Mozilla/5.0 (Smart-TV; Linux; Coolita 3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.114 TV Safari/537.36 Coolita OS QJY/3.0 NETRANGEMMH";},configurable:true});}catch(e){}' +
                            'try{if(navigator.serviceWorker)navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});});}catch(e){}' +
                            'try{if(window.caches)caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k);});});}catch(e){}' +
                            'try{window.ytcfg=window.ytcfg||{};var _os=window.ytcfg.set;window.ytcfg.set=function(k,v){if(typeof k==="object"&&k.EXPERIMENT_FLAGS){}if(_os)return _os.apply(this,arguments);};}catch(e){}' +
                            'function _rw(u){if(!u)return u;try{if(typeof u==="object"&&u.href)u=u.href;if(typeof u==="string"){if(u.indexOf("/cors-bypass/")!==-1)return u;if(u.indexOf(".c.youtube.com")!==-1||u.indexOf(".googlevideo.com")!==-1){var full=u.startsWith("//")?"https:"+u:u;return window.location.origin+"/cors-bypass/"+full;}if(u.indexOf("//www.youtube.com")!==-1||u.indexOf("//youtube.com")!==-1){return u.replace(/^https?:\\/\\/(www\\.)?youtube\\.com/,window.location.origin).replace(/^\\/\\/(www\\.)?youtube\\.com/,window.location.origin);}}}catch(e){}return u;}' +
                            'try{var _vsp=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"src");if(_vsp&&_vsp.set){Object.defineProperty(HTMLMediaElement.prototype,"src",{get:function(){return _vsp.get.call(this);},set:function(u){return _vsp.set.call(this,_rw(u));},configurable:true});}}catch(e){}' +
                            'try{var _f=window.fetch;if(_f){window.fetch=function(i,n){' +
                            'try{' +
                            'if(typeof i==="string"){i=_rw(i);}' +
                            'else if(i instanceof Request){' +
                            'var nu=_rw(i.url);' +
                            'if(i.body){' +
                            'return i.arrayBuffer().then(function(buf){' +
                            'var h=new Headers(i.headers);' +
                            'return _f.call(window,nu,{method:i.method,headers:h,body:buf});' +
                            '});' +
                            '}' +
                            'if(nu!==i.url)i=new Request(nu,i);' +
                            '}' +
                            'else if(i&&i.href){i=_rw(i.href);}' +
                            'if(n&&n.duplex)delete n.duplex;' +
                            '}catch(e){}' +
                            'return _f.call(this,i,n);' +
                            '};}}catch(e){}' +
                            'try{var _op=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,a,user,p){var finalU=_rw(u);try{return _op.call(this,m,finalU,a!==false,user,p);}catch(err){var st=(new Error()).stack||"";var b64="";try{b64=btoa(String(u).slice(0,50));}catch(e){};new Image().src="/tvlog?u_b64="+encodeURIComponent(b64)+"&st="+encodeURIComponent(st.slice(0,400));throw err;}};}catch(e){}' +
                            'try{if(navigator.sendBeacon){var _sb=navigator.sendBeacon;navigator.sendBeacon=function(u,d){return _sb.call(this,_rw(u),d);};}}catch(e){}' +
                            '</script>';
                        if (text.indexOf('<head>') !== -1) {
                            text = text.replace('<head>', `<head>${debugTag}`);
                        } else if (text.indexOf('<head ') !== -1) {
                            text = text.replace(/(<head[^>]*>)/i, `$1${debugTag}`);
                        } else {
                            text = debugTag + text;
                        }
                    }

                    // Server-side JSON Handling
                    if (contentType.indexOf('application/json') !== -1) {
                        try {
                            const data = JSON.parse(text);
                            if (req.url.indexOf('/youtubei/v1/player') !== -1) {
                                console.log('[PLAYER-STATUS]', JSON.stringify(data.playabilityStatus || {}));
                                const isPlayable = data.playabilityStatus && data.playabilityStatus.status === 'OK' && data.streamingData;
                                if (!isPlayable) {
                                    const targetId = reqVideoId || (data.videoDetails && data.videoDetails.videoId);
                                    if (targetId) {
                                        console.log(`[PLAYER-FALLBACK] Resolving stream for videoId: ${targetId}`);
                                        const streamInfo = await getStreamInfo(targetId);
                                        if (streamInfo) {
                                            data.playabilityStatus = { status: 'OK', playableInEmbed: true };
                                            data.streamingData = {
                                                expiresInSeconds: '21600',
                                                hlsManifestUrl: streamInfo.hlsUrl || undefined,
                                                adaptiveFormats: streamInfo.adaptiveFormats
                                            };
                                            if (streamInfo.title) {
                                                data.videoDetails = data.videoDetails || {};
                                                data.videoDetails.videoId = targetId;
                                                data.videoDetails.title = streamInfo.title;
                                                data.videoDetails.lengthSeconds = `${Math.round(streamInfo.duration || 0)}`;
                                            }
                                            console.log(`[PLAYER-FALLBACK] Successfully injected ${streamInfo.adaptiveFormats.length} raw formats + HLS!`);
                                        }
                                    }
                                }
                                if (data.streamingData && Array.isArray(data.streamingData.adaptiveFormats)) {
                                    data.streamingData.adaptiveFormats = data.streamingData.adaptiveFormats.filter(f => {
                                        const mime = f.mimeType || '';
                                        if (mime.indexOf('av01') !== -1 || mime.indexOf('av1') !== -1) return false;
                                        if (f.height && f.height > 1080) return false;
                                        return true;
                                    });
                                }
                                delete data.adPlacements;
                                delete data.adSlots;
                                delete data.playerAds;
                                delete data.adBreakHeartbeatParams;
                                text = JSON.stringify(data);
                            }
                            let modified = false;
                            if (data.adPlacements) { delete data.adPlacements; modified = true; }
                            if (data.playerAds) { delete data.playerAds; modified = true; }
                            if (data.adSlots) { delete data.adSlots; modified = true; }
                            if (data.adBreakHeartbeatParams) { delete data.adBreakHeartbeatParams; modified = true; }
                            if (data.streamingData && Array.isArray(data.streamingData.adaptiveFormats)) {
                                data.streamingData.adaptiveFormats = data.streamingData.adaptiveFormats.filter(f => {
                                    const mime = f.mimeType || '';
                                    if (mime.indexOf('av01') !== -1 || mime.indexOf('av1') !== -1) return false;
                                    if (f.height && f.height > 1080) return false;
                                    return true;
                                });
                                modified = true;
                            }
                            if (data.streamingData || modified) text = JSON.stringify(data);
                        } catch(e) {}
                    }

                    // Static assets CORS bypass
                    text = text.replace(/https:\/\/www\.gstatic\.com/g, `${proxyPrefix}https://www.gstatic.com`);
                    text = text.replace(/http:\/\/www\.gstatic\.com/g, `${proxyPrefix}https://www.gstatic.com`);
                    text = text.replace(/"\/\/www\.gstatic\.com/g, `"${proxyPrefix}https://www.gstatic.com`);
                    text = text.replace(/\(\/\/www\.gstatic\.com/g, `(${proxyPrefix}https://www.gstatic.com`);

                    text = text.replace(/https:\/\/yt3\.ggpht\.com/g, `${proxyPrefix}https://yt3.ggpht.com`);

                    text = text.replace(/https:\/\/clients1\.google\.com/g, `${proxyPrefix}https://clients1.google.com`);
                    text = text.replace(/http:\/\/clients1\.google\.com/g, `${proxyPrefix}https://clients1.google.com`);
                    text = text.replace(/"\/\/clients1\.google\.com/g, `"${proxyPrefix}https://clients1.google.com`);

                    // Video CDN rewrite for router firewall bypass (safe subdomain pattern [a-zA-Z0-9-]+)
                    text = text.replace(/((?:https?:\/\/[^/]+)?\/cors-bypass\/)?https:\/\/([a-zA-Z0-9-]+)\.googlevideo\.com/g, (m, pfx, host) => `${proxyPrefix}https://${host}.googlevideo.com`);
                    text = text.replace(/((?:https?:[\\\/]+[^\\\/]+)?[\\\/]+cors-bypass[\\\/]+)?https:\\\/\\\/([a-zA-Z0-9-]+)\.googlevideo\.com/g, (m, pfx, host) => `${proxyPrefixEscaped}https:\\/\\/${host}.googlevideo.com`);
                    text = text.replace(/((?:https?:\/\/[^/]+)?\/cors-bypass\/)?"\/\/([a-zA-Z0-9-]+)\.googlevideo\.com/g, (m, pfx, host) => `"${proxyPrefix}https://${host}.googlevideo.com`);

                    // c.youtube.com CDN rewrite
                    text = text.replace(/((?:https?:\/\/[^/]+)?\/cors-bypass\/)?https:\/\/([a-zA-Z0-9-]+)\.c\.youtube\.com/g, (m, pfx, host) => `${proxyPrefix}https://${host}.c.youtube.com`);
                    text = text.replace(/((?:https?:[\\\/]+[^\\\/]+)?[\\\/]+cors-bypass[\\\/]+)?https:\\\/\\\/([a-zA-Z0-9-]+)\.c\.youtube\.com/g, (m, pfx, host) => `${proxyPrefixEscaped}https:\\/\\/${host}.c.youtube.com`);
                    text = text.replace(/((?:https?:\/\/[^/]+)?\/cors-bypass\/)?"\/\/([a-zA-Z0-9-]+)\.c\.youtube\.com/g, (m, pfx, host) => `"${proxyPrefix}https://${host}.c.youtube.com`);

                    // redirector.googlevideo.com rewrite
                    text = text.replace(/((?:https?:\/\/[^/]+)?\/cors-bypass\/)?https:\/\/redirector\.googlevideo\.com/g, () => `${proxyPrefix}https://redirector.googlevideo.com`);
                    text = text.replace(/((?:https?:[\\\/]+[^\\\/]+)?[\\\/]+cors-bypass[\\\/]+)?https:\\\/\\\/redirector\.googlevideo\.com/g, () => `${proxyPrefixEscaped}https:\\/\\/redirector.googlevideo.com`);
                    text = text.replace(/((?:https?:\/\/[^/]+)?\/cors-bypass\/)?"\/\/redirector\.googlevideo\.com/g, () => `"${proxyPrefix}https://redirector.googlevideo.com`);

                    // YouTube router & origin fixes
                    text = text.replace('Set(["www.youtube.com","accounts.google.com"]);', `Set(["www.youtube.com", "${hostHeader.split(':')[0]}"]);`);
                    text = text.replace(/:document\.location\.toString\(\)/g, ':"https://www.youtube.com/tv"');
                    text = text.replace(/euri:[^,]+,/g, 'euri:"",');
                    text = text.replace(/case "Escape":case "GoBack":/g, 'case "Escape":case "GoBack":case "Back":case "BrowserBack":');
                    text = text.replace(/https:\/\/s\.youtube\.com/g, `${proxyPrefix}https://s.youtube.com`);
                    text = text.replace(/this\.scheme="https"/, `this.scheme="${proto}"`);
                    text = text.replace(/https\:\/\/jnn-pa.googleapis.com/g, `${proxyPrefix}https://jnn-pa.googleapis.com`);
                    text = text.replace(/https:\/\/yt3\.googleusercontent\.com/g, `${proxyPrefix}https://yt3.googleusercontent.com`);
                    text = text.replace(/"\/\/yt3\.googleusercontent\.com/g, `"${proxyPrefix}https://yt3.googleusercontent.com`);

                    // Cache-bust tv-player scripts so Smart TV never runs stale unpatched cached player
                    text = text.replace(/(tv-player-ias(?:-[a-zA-Z0-9]+)?)\.js/g, '$1.v10.js');

                    // Inject Onesie fixes into player script
                    if (contentType.indexOf('javascript') !== -1 || req.url.indexOf('.js') !== -1) {
                        text = text.replace(/case 6:return Oa=nb\.D\(\),a\.fail\(Oa\)/g, 'case 6:return Oa=nb.D(),a.fail(Oa)');
                        text = text.replace(/m\.fail=function\(a\)\{var b=this;/g, 'm.fail=function(a){var b=this;');
                        text = text.replace(/function Yp\(a\)\{return\/[^}]+\}/g, 'function Yp(a){return true}');
                        text = text.replace('function v1a(a){', 'function v1a(a){return false;');
                        
                        text = text.replace(/function Zp\(a\)\{var b=\/[^}]+\}/g, 'function Zp(a){return true}');
                        text = text.replace(/function KS\(a,b,d\)\{[^}]+\}/g, 'function KS(a,b,d){return true}');
                        text = text.replace(/function Kc\(a\)\{[^}]+\}/g, 'function Kc(a){return true}');
                        text = text.replace('function rm(a,b){', 'function rm(a,b){try{console.error("[RM_ERR_STACK]",a&&a.stack);new Image().src="/tvlog?log="+encodeURIComponent("RM_ERR_STACK: "+(a&&a.stack));}catch(e){};');
                        text = text.replace('function Zj(a,b,d){', 'function Zj(a,b,d){try{console.error("[YTERR_Zj]",a,JSON.stringify(b),(new Error()).stack);new Image().src="/tvlog?log="+encodeURIComponent("YTERR_Zj: "+a+" details="+JSON.stringify(b));}catch(e){};');
                        text = text.replace(/function LS\(a\)\{[^}]+\}/g, 'function LS(a){return true}');
                        text = text.replace(/throw new Lc\(c\[[^\]]+\],d\[[^\]]+\]\);?/g, '{}');
                        text = text.replace(/Qc\(new Lc\(c\[[^\]]+\],d\[[^\]]+\]\)\)/g, 'true');
                    }

                    // Fix history
                    text = text.replace(/=window\.location\.href;/, `=window.location.href.replace("${proxyHost}", "https://www.youtube.com");`);
                    text = text.replace(/=document\.location\.href/, `=document.location.href.replace("${proxyHost}", "https://www.youtube.com")`);

                    // Inject TizenTube userScript into /tv
                    if (req.url.indexOf('/tv') === 0 && req.url.indexOf('/tv_config') === -1) {
                        if (text.indexOf('</body>') !== -1) {
                            text = text.replace('</body>', '<script src="/tizentube.js"></script></body>');
                        } else {
                            text += '<script src="/tizentube.js"></script>';
                        }
                    }

                    res.send(text);
                });
            } else {
                if (response.body) {
                    response.body.pipe(res);
                } else {
                    res.end();
                }
            }
        })
        .catch((error) => {
            console.error(`Proxy Error for [${targetUrl}]: ${error.message}`);
            if (!res.headersSent) {
                res.status(500).send('Proxy Connection Broken');
            }
        });
});

http.createServer(app).listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`[TizenTube Proxy] HTTP running on http://0.0.0.0:${HTTP_PORT}`);
});

try {
    const sslOptions = {
        key: fs.readFileSync('/etc/nginx/ssl/my.key'),
        cert: fs.readFileSync('/etc/nginx/ssl/my.crt'),
        ALPNProtocols: ['http/1.1']
    };
    https.createServer(sslOptions, app).listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`[TizenTube Proxy] HTTPS running on https://0.0.0.0:${HTTPS_PORT}`);
    });
} catch(e) {
    console.error(`[TizenTube Proxy] HTTPS failed to start: ${e.message}`);
}
