# Dino-Bill - ISP Management System 🦖 [V1.0]

**Dino-Bill** adalah solusi *all-in-one* untuk manajemen billing dan operasional ISP (Internet Service Provider) yang dirancang untuk berjalan secara autopilot. Sistem ini memudahkan pengelolaan pelanggan, isolir otomatis, hingga integrasi pembayaran digital.

---

## 🚀 Fitur Utama
- ✅ **Autopilot Billing**: Pembuatan invoice otomatis secara massal setiap bulan.
- ✅ **Auto-Isolation**: Pemutusan layanan (isolir) otomatis bagi pelanggan yang menunggak (via MikroTik API).
- ✅ **Payment Gateway**: Integrasi **Tripay** (QRIS, VA, E-Wallet) untuk konfirmasi pembayaran otomatis.
- ✅ **Portal Pelanggan**: Cek tagihan, riwayat pembayaran, lapor gangguan, dan kontrol ONT mandiri.
- ✅ **Portal Teknisi & Sales**: Manajemen tugas instalasi, perbaikan, dan manajemen lead penjualan.
- ✅ **Notifikasi WhatsApp**: Pengiriman tagihan, pengingat jatuh tempo, dan bukti bayar otomatis (Local Engine).
- ✅ **Integrasi OLT & ACS**: Monitoring status ONU (Signal, Status) dan manajemen parameter ONT via GenieACS.
- ✅ **Peta Jaringan**: Visualisasi lokasi pelanggan, ODP, dan jalur kabel di Google Maps.

## Persyaratan Sistem
- OS: Ubuntu 20.04 / 22.04 (Rekomendasi)
- CPU: 1 Core+, RAM: 1GB+
- Node.js: v18+
- Database: MySQL 8.0+ atau MariaDB 10.x
- MikroTik: RouterOS v6.x / v7.x (API enabled)

---

## 🛠️ Instalasi Otomatis (Rekomendasi)
Gunakan perintah satu baris ini untuk menginstall semua dependensi (Node.js, MySQL, PM2, Chrome) dan aplikasi secara otomatis:

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
