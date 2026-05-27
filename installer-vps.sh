#!/bin/bash

# Konfigurasi Warna untuk output terminal
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}   Auto-Installer Dino-Bill (NAT VPS)     ${NC}"
echo -e "${GREEN}==========================================${NC}"

# 1. Cek Akses Root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: Tolong jalankan script ini sebagai root (Gunakan 'sudo su').${NC}"
  exit 1
fi

# 2. Deteksi Package Manager (Agar support banyak OS)
if [ -x "$(command -v apt-get)" ]; then
    PKG_MGR="apt-get"
    echo -e "${YELLOW}Terdeteksi OS berbasis Debian/Ubuntu...${NC}"
    $PKG_MGR update -y
    $PKG_MGR install -y curl git wget unzip software-properties-common
elif [ -x "$(command -v yum)" ]; then
    PKG_MGR="yum"
    echo -e "${YELLOW}Terdeteksi OS berbasis CentOS/RHEL...${NC}"
    $PKG_MGR update -y
    $PKG_MGR install -y curl git wget unzip
else
    echo -e "${RED}OS tidak didukung. Script ini mendukung apt (Ubuntu/Debian) atau yum (CentOS/RHEL).${NC}"
    exit 1
fi

# 3. Install Node.js & NPM (Menggunakan NodeSource LTS / v20)
echo -e "${GREEN}>>> Menginstall Node.js...${NC}"
if [ "$PKG_MGR" == "apt-get" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    $PKG_MGR install -y nodejs
else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    $PKG_MGR install -y nodejs
fi

# 4. Install PM2 Secara Global
echo -e "${GREEN}>>> Menginstall PM2...${NC}"
npm install -g pm2

# 5. Install MongoDB (Lokal)
echo -e "${GREEN}>>> Menginstall MongoDB...${NC}"
if [ "$PKG_MGR" == "apt-get" ]; then
    $PKG_MGR install -y mongodb || $PKG_MGR install -y mongodb-org
    # Mencoba menjalankan service mongo (beberapa NAT VPS tidak support systemctl)
    systemctl enable mongodb || systemctl enable mongod
    systemctl start mongodb || systemctl start mongod
else
    echo -e "${YELLOW}Peringatan: Untuk CentOS, harap install MongoDB secara manual atau gunakan MongoDB Atlas.${NC}"
fi

# 6. Clone Repository Github (Branch: public)
echo -e "${GREEN}>>> Mengkloning Repository Dino-Bill...${NC}"
cd /opt
if [ -d "Dino-Bill" ]; then
    echo -e "${YELLOW}Menghapus direktori lama...${NC}"
    rm -rf Dino-Bill
fi
git clone -b public https://github.com/heruhendri/Dino-Bill.git
cd Dino-Bill

# 7. Install Dependensi Proyek
echo -e "${GREEN}>>> Menginstall Dependensi NPM (npm install)...${NC}"
npm install

# 8. Setup Environment Variable
if [ -f ".env.example" ]; then
    cp .env.example .env
    echo -e "${YELLOW}File .env berhasil dibuat dari .env.example.${NC}"
fi

# 9. Menjalankan Aplikasi dengan PM2
echo -e "${GREEN}>>> Menjalankan aplikasi dengan PM2...${NC}"
# Asumsi entry point adalah index.js. Jika beda, pm2 akan mencoba server.js atau app.js
pm2 start index.js --name "Dino-Bill" || pm2 start server.js --name "Dino-Bill" || pm2 start app.js --name "Dino-Bill"
pm2 save
pm2 startup

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}      Instalasi Selesai & Berhasil!       ${NC}"
echo -e "${GREEN}==========================================${NC}"