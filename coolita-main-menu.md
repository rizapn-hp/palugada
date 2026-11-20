# Panduan Lengkap: Kustomisasi Menu Utama & Redirect Aplikasi Coolita OS Smart TV (Metode Single-Domain API Intercept)

Panduan ini mendokumentasikan cara paling bersih, efisien, dan modern untuk memodifikasi daftar icon aplikasi pada **Menu Utama / Input Bar** Smart TV berbasis **Coolita OS** (Coocaa / Skyworth).

Metode ini **jauh lebih sederhana** daripada teknik DNS spoofing lama per-aplikasi karena:
1. **Hanya butuh 1 DNS Rewrite**: Cukup belokkan satu domain API Coocaa (`api-home-litaos.coocaa.in`) ke MiniPC.
2. **Hanya butuh 1 URL Intercept**: Nginx hanya memodifikasi respons `/tvos/direct-tab?tabType=18`.
3. **Bebas Mengubah URL & Gambar**: Seluruh icon di menu utama TV dapat diarahkan ke aplikasi lokal (TizenTube, IPTV Launcher, Telegram TV) lengkap dengan poster/banner kustom berasio **2:1 landscape**.
4. **Resiko Nol Terhadap Sistem Asli TV**: Semua request API Coocaa lainnya diteruskan (*reverse-proxied*) secara transparan ke server asli Coocaa di internet.

---

## 1. Arsitektur & Cara Kerja

Coolita OS menggunakan arsitektur hybrid. Menu bar aplikasi (yang muncul saat tombol **[INPUT]** atau menu Home dibuka) dirender oleh browser Chromium internal (`file:///skyworth/app/web/home/Home.html`).

Saat TV dinyalakan atau menu dibuka, browser TV mengunduh konfigurasi daftar aplikasi dari cloud Coocaa melalui endpoint `direct-tab?tabType=18`. Dengan menempatkan MiniPC sebagai reverse proxy (MITM), kita dapat mengganti respons JSON tersebut dengan daftar aplikasi lokal kita.

```mermaid
flowchart TD
    TV["Smart TV Coolita OS\n(192.168.1.232)"]
    DNS["AdGuard Home / DNS Resolver\n(192.168.1.53:53)"]
    NGINX["Nginx Reverse Proxy di MiniPC\n(192.168.1.53:80 / :443)"]
    CLOUD["Cloud Asli Coocaa\n(https://api-home-litaos.coocaa.in)"]
    LOCAL_APPS["Layanan Lokal di MiniPC\n- TizenTube (:8100/tv)\n- IPTV Launcher (/c/)\n- Telegram TV (/c/tele/)"]

    TV -->|"1. Query DNS: api-home-litaos.coocaa.in"| DNS
    DNS -->|"2. Return IP MiniPC: 192.168.1.53"| TV

    TV -->|"3. GET /tvos/direct-tab?tabType=18"| NGINX
    NGINX -- "Cocok tabType=18" -->|"4a. Kirim custom_direct_tab_18.json"| TV
    NGINX -- "URL API Coocaa Lainnya" -->|"4b. Forward transparan (proxy_pass)"| CLOUD
    CLOUD -->|"Kembalikan respons asli"| NGINX --> TV

    TV -->|"5. Klik Icon (YouTube / Vision+ / Games)"| LOCAL_APPS
```

---

## 2. Kebutuhan Perangkat & Perangkat Lunak

1. **Smart TV Coolita OS** (Coocaa / Skyworth):
   - Terhubung ke jaringan Wi-Fi atau LAN rumah yang sama.
2. **Server Linux Lokal** (MiniPC, Raspberry Pi, Home Server, atau VPS LAN):
   - Contoh IP Statis: `192.168.1.53`.
   - **Nginx Web Server**: Berfungsi sebagai HTTPS/HTTP Reverse Proxy & Web Server banner.
   - **DNS Server Lokal**: AdGuard Home, Pi-hole, atau dnsmasq di OpenWrt.
   - **OpenSSL**: Untuk membuat sertifikat SSL dummy (agar HTTPS handshake TV sukses).

---

## 3. Langkah 1: Siapkan Sertifikat SSL Dummy di Nginx

TV memanggil API Coocaa via protokol HTTPS (port 443). Nginx di MiniPC harus memiliki sertifikat SSL untuk menangani handshake TLS tersebut:

```bash
mkdir -p /etc/nginx/ssl
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/my.key \
  -out /etc/nginx/ssl/my.crt \
  -subj "/CN=api-home-litaos.coocaa.in" \
  -addext "subjectAltName=DNS:api-home-litaos.coocaa.in,DNS:*.coocaa.in,DNS:*.coocaa.asia"
```

---

## 4. Langkah 2: Buat Banner Icon Kustom (Rasio 2:1 Landscape)

TV Coolita menggunakan rasio **2:1 (landscape)** untuk icon aplikasi di menu utama.
- **Resolusi Optimal**: `800 x 400 px` (sangat tajam di TV 1080p & 4K) atau `400 x 200 px`.
- **Desain**: *Full-bleed* (warna latar memenuhi seluruh kotak tanpa bingkai kosong tipis).

Simpan gambar banner di web server lokal (misalnya `/var/www/html/c/assets/`):
1. **Banner Telegram TV**: `/var/www/html/c/assets/telegram_banner.png` (Background biru gradient `#24A1DE` + Logo Telegram).
2. **Banner IPTV Launcher**: `/var/www/html/c/assets/iptv_banner.png` (Background slate dark navy `#0f172a` + Logo TV cyan).

> [!TIP]
> Anda dapat membuat banner menggunakan script Python Pillow sederhana atau mendesainnya di Canva/Photoshop dengan ukuran `800x400`. Pastikan gambar berekstensi PNG/JPG dan dapat diakses dari browser: `http://192.168.1.53/c/assets/telegram_banner.png`.

---

## 5. Langkah 3: Siapkan File `custom_direct_tab_18.json`

File ini menggantikan respons cloud Coocaa saat TV meminta daftar aplikasi menu. Simpan file ini di `/var/www/html/custom_direct_tab_18.json`.

Struktur penting yang harus dimodifikasi ada di dalam objek `extra.block_content_info`:
- **`title`**: Judul yang muncul di bawah/atas icon.
- **`app_info.app_url`**: URL target yang dibuka saat icon diklik.
- **`action`**: String JSON yang berisi perintah peluncuran browser/webview TV.
- **`imgs.poster.images`**: Array URL gambar banner (bisa URL HTTP dari MiniPC).
- **`cycle_time`**: Wajib diisi `0` agar TV tidak menunda pembaruan.
- **`md5`**: Diisi string epoch timestamp saat ini agar TV mendeteksi versi baru dan membuang cache IndexedDB lama.

### Template Lengkap `/var/www/html/custom_direct_tab_18.json`:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "cycle_time": 0,
    "homepage_id": 10553,
    "homepage_name": "印尼-正式-TV",
    "md5": "1795100528",
    "refresh_info": null,
    "sink_size": 1,
    "tab_config": "{}",
    "tab_id": 1050574,
    "tab_name_en": "APPS",
    "content": {
      "bg": "",
      "contents": [
        {
          "bg": "",
          "contents": [
            {
              "type": "Block",
              "id": "105057488",
              "focusable": 1,
              "width": 410,
              "height": 205,
              "x": 0,
              "y": 0,
              "extra": {
                "title": "YouTube",
                "block_content_info": {
                  "title": "YouTube",
                  "content_status": 1,
                  "app_info": {
                    "app_url": "http://192.168.1.53:8100/tv",
                    "supplier": "custom"
                  },
                  "action": "{\"avod\": false, \"bywhat\": \"action\", \"dowhat\": \"startActivity\", \"params\": {\"id\": \"303\", \"url\": \"http://192.168.1.53:8100/tv\"}, \"byurl\": \"http://192.168.1.53:8100/tv\"}",
                  "imgs": {
                    "poster": {
                      "images": [
                        "https://res-litaos.coocaa.in/virgo/img/072/2120/tr3447062108-icc-200.png"
                      ]
                    }
                  }
                }
              }
            },
            {
              "type": "Block",
              "id": "105057489",
              "focusable": 1,
              "width": 410,
              "height": 205,
              "x": 450,
              "y": 0,
              "extra": {
                "title": "Browser",
                "block_content_info": {
                  "title": "Browser",
                  "content_status": 1,
                  "app_info": {
                    "app_url": "https://coolita.com/coobrowser/home.html",
                    "supplier": "custom"
                  },
                  "action": "{\"avod\": false, \"bywhat\": \"action\", \"dowhat\": \"startActivity\", \"params\": {\"id\": \"536\", \"url\": \"https://coolita.com/coobrowser/home.html\"}}",
                  "imgs": {
                    "poster": {
                      "images": [
                        "https://res-litaos.coocaa.in/virgo/img/third/new/20260907/20260907131635856443.jpg"
                      ]
                    }
                  }
                }
              }
            },
            {
              "type": "Block",
              "id": "105057490",
              "focusable": 1,
              "width": 410,
              "height": 205,
              "x": 900,
              "y": 0,
              "extra": {
                "title": "Coolita Channel",
                "block_content_info": {
                  "title": "Coolita Channel",
                  "content_status": 1,
                  "app_info": {
                    "app_url": "http://192.168.1.53/c/index.html",
                    "supplier": "custom"
                  },
                  "action": "{\"avod\": false, \"bywhat\": \"action\", \"dowhat\": \"startActivity\", \"params\": {\"id\": \"598\", \"url\": \"http://192.168.1.53/c/index.html\"}}",
                  "imgs": {
                    "poster": {
                      "images": [
                        "https://res-litaos.coocaa.in/virgo/img/third/new/20240202/20240202134620883971.png"
                      ]
                    }
                  }
                }
              }
            },
            {
              "type": "Block",
              "id": "105057491",
              "focusable": 1,
              "width": 410,
              "height": 205,
              "x": 1350,
              "y": 0,
              "extra": {
                "title": "Vidio",
                "block_content_info": {
                  "title": "Vidio",
                  "content_status": 1,
                  "app_info": {
                    "app_url": "https://tv.vidio.com",
                    "supplier": "custom"
                  },
                  "action": "{\"avod\": false, \"bywhat\": \"action\", \"dowhat\": \"startActivity\", \"params\": {\"id\": \"352\", \"opentype\": \"Vidio\", \"url\": \"https://tv.vidio.com\"}}",
                  "imgs": {
                    "poster": {
                      "images": [
                        "https://res-litaos.coocaa.in/virgo/img/third/new/20240109/20240109165039925290.png"
                      ]
                    }
                  }
                }
              }
            },
            {
              "type": "Block",
              "id": "105057492",
              "focusable": 1,
              "width": 410,
              "height": 205,
              "x": 0,
              "y": 245,
              "extra": {
                "title": "IPTV Launcher",
                "block_content_info": {
                  "title": "IPTV Launcher",
                  "content_status": 1,
                  "app_info": {
                    "app_url": "http://192.168.1.53/c/",
                    "supplier": "custom"
                  },
                  "action": "{\"avod\": false, \"bywhat\": \"action\", \"dowhat\": \"startActivity\", \"params\": {\"id\": \"593\", \"url\": \"http://192.168.1.53/c/\"}, \"byurl\": \"http://192.168.1.53/c/\"}",
                  "imgs": {
                    "poster": {
                      "images": [
                        "http://192.168.1.53/c/assets/iptv_banner.png?v=1795100528"
                      ]
                    }
                  }
                }
              }
            },
            {
              "type": "Block",
              "id": "105057493",
              "focusable": 1,
              "width": 410,
              "height": 205,
              "x": 450,
              "y": 245,
              "extra": {
                "title": "Telegram",
                "block_content_info": {
                  "title": "Telegram",
                  "content_status": 1,
                  "app_info": {
                    "app_url": "http://192.168.1.53/c/tele/index.html",
                    "supplier": "custom"
                  },
                  "action": "{\"avod\": false, \"bywhat\": \"action\", \"dowhat\": \"startActivity\", \"params\": {\"id\": \"931\", \"url\": \"http://192.168.1.53/c/tele/index.html\"}, \"byurl\": \"http://192.168.1.53/c/tele/index.html\"}",
                  "imgs": {
                    "poster": {
                      "images": [
                        "http://192.168.1.53/c/assets/telegram_banner.png?v=1795100528"
                      ]
                    }
                  }
                }
              }
            },
            {
              "type": "Block",
              "id": "105057494",
              "focusable": 1,
              "width": 410,
              "height": 205,
              "x": 900,
              "y": 245,
              "extra": {
                "title": "Mola TV",
                "block_content_info": {
                  "title": "Mola TV",
                  "content_status": 1,
                  "app_info": {
                    "app_url": "https://coolitav3.mola.tv/#/",
                    "supplier": "custom"
                  },
                  "action": "{\"avod\": false, \"bywhat\": \"action\", \"dowhat\": \"startActivity\", \"params\": {\"id\": \"580\", \"opentype\": \"Mola TV\", \"url\": \"https://coolitav3.mola.tv/#/\"}}",
                  "imgs": {
                    "poster": {
                      "images": [
                        "https://res-litaos.coocaa.in/virgo/img/third/new/20240403/20240403112436928185.png"
                      ]
                    }
                  }
                }
              }
            }
          ]
        }
      ]
    }
  }
}
```

---

## 6. Langkah 4: Konfigurasi Nginx MITM Reverse Proxy

Buat konfigurasi virtual host di `/etc/nginx/sites-available/api-home-coocaa`:

```nginx
server {
    listen 80;
    listen 443 ssl;
    server_name api-home-litaos.coocaa.in;

    ssl_certificate /etc/nginx/ssl/my.crt;
    ssl_certificate_key /etc/nginx/ssl/my.key;

    # DNS publik untuk forward request asli ke server Coocaa internet
    resolver 1.1.1.1 8.8.8.8 ipv6=off valid=300s;
    resolver_timeout 5s;

    # 1. INTERCEPT: Daftar Icon Menu Utama (tabType=18)
    location = /tvos/direct-tab {
        if ($arg_tabType = "18") {
            rewrite ^ /_custom_tab18 last;
        }
        set $upstream_endpoint https://api-home-litaos.coocaa.in;
        proxy_pass $upstream_endpoint;
        proxy_set_header Host api-home-litaos.coocaa.in;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_ssl_server_name on;
        proxy_ssl_name api-home-litaos.coocaa.in;
        proxy_ssl_protocols TLSv1.2 TLSv1.3;
    }

    # Blok internal yang melayani JSON kustom bebas cache
    location = /_custom_tab18 {
        internal;
        default_type application/json;
        add_header Content-Type "application/json;charset=UTF-8" always;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        etag off;
        if_modified_since off;
        alias /var/www/html/custom_direct_tab_18.json;
    }

    # 2. TRANSPARENT PROXY: Teruskan semua API Coocaa lainnya ke internet
    location / {
        set $upstream_endpoint https://api-home-litaos.coocaa.in;
        proxy_pass $upstream_endpoint;
        proxy_set_header Host api-home-litaos.coocaa.in;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_ssl_server_name on;
        proxy_ssl_name api-home-litaos.coocaa.in;
        proxy_ssl_protocols TLSv1.2 TLSv1.3;

        proxy_buffering off;
        proxy_read_timeout 60s;
        proxy_connect_timeout 5s;
    }
}
```

Aktifkan konfigurasi dan reload Nginx:
```bash
ln -sf /etc/nginx/sites-available/api-home-coocaa /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## 7. Langkah 5: Setup DNS Rewrite (Hanya 1 Domain)

Pada DNS Server lokal Anda (**AdGuard Home**, **Pi-hole**, atau **dnsmasq OpenWrt**), tambahkan 1 aturan DNS Rewrite saja:

### Jika Menggunakan AdGuard Home:
Masuk ke menu **Filters** $\rightarrow$ **DNS rewrites**, tambahkan:
- **Domain**: `api-home-litaos.coocaa.in`
- **IP Address (Answer)**: `192.168.1.53` *(IP MiniPC)*

*(Atau via baris konfigurasi `/opt/AdGuardHome/AdGuardHome.yaml`)*:
```yaml
  rewrites:
    - domain: api-home-litaos.coocaa.in
      answer: 192.168.1.53
      enabled: true
```

### Jika Menggunakan dnsmasq (OpenWrt):
```bash
echo "address=/api-home-litaos.coocaa.in/192.168.1.53" >> /etc/dnsmasq.conf
/etc/init.d/dnsmasq restart
```

---

## 8. Langkah 6: Pengaturan Jaringan pada Smart TV Coolita

Agar pembelokan berfungsi, TV harus diarahkan menggunakan MiniPC sebagai DNS Server:
1. Buka **Settings (Pengaturan)** di TV Coolita.
2. Pilih **Network (Jaringan)** $\rightarrow$ Pilih koneksi Wi-Fi / Ethernet aktif Anda.
3. Ubah pengaturan IP dari DHCP menjadi **Static**:
   - **IP Address**: IP TV saat ini (contoh: `192.168.1.232`)
   - **Subnet Mask**: `255.255.255.0`
   - **Gateway**: IP Router Anda (contoh: `192.168.1.1`)
   - **DNS 1 (Primary)**: **`192.168.1.53`** *(IP MiniPC)*
   - **DNS 2 (Secondary)**: Kosongkan atau samakan dengan DNS 1 (jangan diisi `8.8.8.8` agar tidak bypass).
4. Simpan konfigurasi.

---

## 9. Verifikasi & Pengujian

### 1. Uji Endpoint dari Terminal MiniPC:
Jalankan perintah berikut di MiniPC untuk memastikan Nginx mengirimkan JSON kustom dengan status 200 OK:
```bash
curl -s -i -H 'Host: api-home-litaos.coocaa.in' 'http://127.0.0.1/tvos/direct-tab?tabType=18' | head -n 25
```
Pastikan header memuat `Cache-Control: no-store...` dan isi JSON memuat URL MiniPC Anda (`http://192.168.1.53...`).

### 2. Uji di Layar Smart TV:
1. Tekan tombol **[INPUT]** pada remote TV atau buka menu Home.
2. Perhatikan icon aplikasi:
   - Icon **YouTube** kini langsung meluncurkan TizenTube (bebas iklan).
   - Icon **Vision+** berubah menjadi **IPTV Launcher** lengkap dengan banner custom.
   - Icon **Free Games** berubah menjadi **Telegram TV** lengkap dengan logo resmi Telegram.
3. Klik salah satu icon tersebut. TV akan langsung membuka web aplikasi MiniPC tanpa delay dan tanpa melewati proses redirect pihak ketiga!

---

## 10. Catatan Penting: Mengapa Tombol Remote Fisik Tidak Menggunakan Cara Ini?

| Tombol Remote Fisik | Mengapa Tidak Bisa Diubah via Intercept API? | Solusi Terbaik |
| :--- | :--- | :--- |
| **[YouTube]** | Disertifikasi resmi oleh Google. Diproses langsung di kernel Linux (`/dev/input`) untuk meluncurkan binary native Google Cobalt (`libcobalt.so`). | Gunakan icon **YouTube** di menu layar (sudah otomatis buka TizenTube) atau DNS spoofing `www.youtube.com`. |
| **[Prime Video]** | Disertifikasi resmi oleh Amazon. Membuka binary DRM NetRange CDM langsung di level driver hardware. | Gunakan icon menu layar. |
| **[iQIYI]** | Firmware TV memanggil domain bawaan `tv.iq.com` saat tombol ditekan. | Tambahkan 1 DNS rewrite `tv.iq.com` $\rightarrow$ `192.168.1.53` di AdGuard Home + Nginx vhost `iqiyi` untuk auto-redirect ke IPTV Player. |

---

## 11. Kesimpulan

Metode **Single-Domain API Intercept** pada `api-home-litaos.coocaa.in/tvos/direct-tab?tabType=18` adalah solusi **paling bersih dan elegan** untuk mengubah tampilan aplikasi Smart TV Coolita:
- Tidak perlu spoofing banyak domain eksternal (`play.works`, `365qtv`, dll).
- Tidak memicu error sertifikat SSL pada aplikasi lain.
- Tampilan icon beresolusi tinggi 2:1 landscape membuat UI TV terlihat seperti aplikasi native resmi berbayar.
