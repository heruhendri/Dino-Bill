# 🦖 Dino-Bill - ISP Management System [V1.0]

[![GitHub stars](https://img.shields.io/github/stars/heruhendri/Dino-Bill?style=for-the-badge)](https://github.com/heruhendri/Dino-Bill/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Telegram Support](https://img.shields.io/badge/Telegram-Group-blue?style=for-the-badge&logo=telegram)](https://t.me/dinosupports)

**Dino-Bill** adalah platform manajemen ISP (Internet Service Provider) berbasis web yang dirancang khusus untuk mempermudah operasional ISP lokal. Mulai dari billing otomatis, manajemen infrastruktur (OLT/MikroTik), hingga pembayaran otomatis via Payment Gateway.

---

## 📺 Tampilan Dashboard
> *Pratinjau antarmuka Dino-Bill yang modern dan responsif.*

| Dashboard Utama | Peta Jaringan | Manajemen Pelanggan |
| :---: | :---: | :---: |
| ![Dashboard](https://via.placeholder.com/400x250?text=Dashboard+Dino-Bill) | ![Network Map](https://via.placeholder.com/400x250?text=Network+Map) | ![Customers](https://via.placeholder.com/400x250?text=Customer+Management) |

---

## 🚀 Fitur Unggulan

### 💰 Billing & Keuangan
- **Autopilot Billing**: Generate invoice massal otomatis setiap tanggal yang ditentukan.
- **Payment Gateway**: Integrasi **Tripay** (VA, QRIS, Retail) dengan konfirmasi otomatis.
- **Auto-Isolir**: Memutus internet pelanggan secara otomatis jika melewati jatuh tempo via MikroTik API.
- **WhatsApp Notification**: Kirim tagihan, pengingat, dan bukti bayar otomatis (Tanpa biaya pihak ketiga).

### 📡 Manajemen Infrastruktur
- **MikroTik Integration**: Manajemen PPPoE, Hotspot, Voucher, dan Monitoring Traffic secara real-time.
- **OLT Hioso Monitoring**: Pantau status ONU (Online/Offline) dan RX Power langsung dari dashboard.
- **GenieACS Integration**: Kontrol parameter ONT (SSID/Password) dari jarak jauh.
- **Network Map**: Visualisasi jalur kabel, posisi ODP, dan lokasi pelanggan menggunakan Google Maps API.

### 👥 Portal & Manajemen
- **Portal Pelanggan**: Login khusus pelanggan untuk cek tagihan dan kontrol perangkat.
- **Portal Teknisi**: Manajemen tiket gangguan dan inventaris barang (Modem/Kabel).
- **Portal Sales**: Pelacakan leads dan prospek pelanggan baru.
- **Inventory System**: Pantau stok modem, kabel drop, dan alat kerja lainnya.

---

## 📋 Persyaratan Sistem
*   **OS**: Ubuntu 20.04 / 22.04 LTS (Disarankan)
*   **Spek**: Minimal 1 vCPU & 1GB RAM
*   **Software**: Node.js v18, MySQL 8.0/MariaDB, Chrome (untuk WhatsApp Engine)
*   **Hardware**: MikroTik (RouterOS v6/v7)

---

## 🛠️ Instalasi Otomatis (Rekomendasi)

Script ini akan secara otomatis menginstall Node.js, MySQL, Chrome, mengkloning aplikasi, dan mengonfigurasi database Anda.

```bash
curl -sSL https://raw.githubusercontent.com/heruhendri/Dino-Bill/public/installer-vps.sh | bash
```

## Instalasi Manual
1. Clone repository:
   ```bash
   git clone https://github.com/heruhendri/Dino-Bill.git
   cd Dino-Bill
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Jalankan aplikasi:
   ```bash
   node server.js
   ```
4. Buka browser dan akses `http://ip-server:3999` untuk memulai Web Installer.

## Support join group
- https://t.me/dinosupports
## Lisensi
MIT License - Bebas dikembangkan untuk kebutuhan ISP lokal.
