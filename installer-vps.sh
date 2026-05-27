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

# 3. Install Node.js & NPM (Menggunakan NodeSource v18)
echo -e "${GREEN}>>> Mengecek Node.js...${NC}"
if command -v node &> /dev/null; then
    NODE_VER=$(node -v)
    echo -e "${YELLOW}Node.js sudah terinstall: $NODE_VER${NC}"
    echo -ne "${YELLOW}Apakah Anda ingin menginstall ulang Node.js v18? (y/n): ${NC}"
    read -r REINSTALL_NODE < /dev/tty
else
    REINSTALL_NODE="y"
fi

if [[ "$REINSTALL_NODE" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo -e "${GREEN}>>> Menginstall Node.js...${NC}"
    if [ "$PKG_MGR" == "apt-get" ]; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        $PKG_MGR install -y nodejs
    else
        curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
        $PKG_MGR install -y nodejs
    fi
else
    echo -e "${YELLOW}>>> Menggunakan versi Node.js yang sudah ada.${NC}"
fi

# 4. Install MySQL Server
echo -e "${GREEN}>>> Menginstall MySQL Server...${NC}"
if [ "$PKG_MGR" == "apt-get" ]; then
    $PKG_MGR install -y mysql-server
    systemctl enable mysql
    systemctl start mysql
else
    $PKG_MGR install -y mariadb-server
    systemctl enable mariadb
    systemctl start mariadb
fi

# 5. Konfigurasi Database
echo -e "${GREEN}>>> Konfigurasi Database...${NC}"
echo -ne "${YELLOW}Gunakan konfigurasi database default? (DB: dino_db, User: root, Password: root) (y/n): ${NC}"
read -r USE_DEFAULT_DB < /dev/tty

if [[ "$USE_DEFAULT_DB" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    DB_NAME="dino_db"
    DB_USER="root"
    DB_PASSWORD="root"
else
    echo -ne "${YELLOW}Masukkan Nama Database: ${NC}"
    read -r DB_NAME < /dev/tty
    echo -ne "${YELLOW}Masukkan Username Database: ${NC}"
    read -r DB_USER < /dev/tty
    echo -ne "${YELLOW}Masukkan Password Database: ${NC}"
    read -r DB_PASSWORD < /dev/tty
fi

echo -e "${GREEN}>>> Menyiapkan Database di MySQL...${NC}"
# Set password root jika belum ada dan buat database
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '$DB_PASSWORD';" 2>/dev/null || mysql -u root -p"$DB_PASSWORD" -e "SELECT 1;" &>/dev/null

mysql -u root -p"$DB_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`;"
mysql -u root -p"$DB_PASSWORD" -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';"
mysql -u root -p"$DB_PASSWORD" -e "GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';"

# Migrasi Nama Kolom Plugin (Key -> Password)
mysql -u root -p"$DB_PASSWORD" -D "$DB_NAME" -e "CREATE TABLE IF NOT EXISTS plugins (id INT AUTO_INCREMENT PRIMARY KEY, plugin_key VARCHAR(255), license_password VARCHAR(255), status VARCHAR(50));"
mysql -u root -p"$DB_PASSWORD" -D "$DB_NAME" -e "IF EXISTS (SELECT * FROM information_schema.COLUMNS WHERE TABLE_NAME='plugins' AND COLUMN_NAME='license_key') THEN ALTER TABLE plugins CHANGE license_key license_password VARCHAR(255); END IF;" 2>/dev/null

mysql -u root -p"$DB_PASSWORD" -e "FLUSH PRIVILEGES;"
echo -e "${YELLOW}Database $DB_NAME berhasil disiapkan.${NC}"

# 5. Install Google Chrome (Untuk Engine WhatsApp)
if [ "$PKG_MGR" == "apt-get" ]; then
    echo -e "${GREEN}>>> Menginstall Google Chrome untuk WhatsApp engine...${NC}"
    wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    $PKG_MGR install -y ./google-chrome-stable_current_amd64.deb
    rm google-chrome-stable_current_amd64.deb
fi

# 6. Install PM2 Secara Global
echo -e "${GREEN}>>> Menginstall PM2...${NC}"
npm install -g pm2

# 7. Clone Repository Github
echo -e "${GREEN}>>> Mengkloning Repository Dino-Bill...${NC}"
cd /opt
if [ -d "Dino-Bill" ]; then
    echo -e "${YELLOW}Update repository yang sudah ada...${NC}"
    cd Dino-Bill
    git pull
else
    git clone https://github.com/heruhendri/Dino-Bill.git
    cd Dino-Bill
fi

# 8. Install Dependensi Proyek
echo -e "${GREEN}>>> Menginstall Dependensi NPM (npm install)...${NC}"
PUPPETEER_SKIP_DOWNLOAD=true npm install

# 8.5 Membuat file .env
echo -e "${GREEN}>>> Membuat file konfigurasi .env...${NC}"
cat <<EOF > .env
DB_HOST=localhost
DB_PORT=3306
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
APP_PORT=3999
APP_NAME=Dino-Bill
NODE_ENV=production
SESSION_SECRET=$(openssl rand -hex 32)
EOF

# 9. Menjalankan Aplikasi dengan PM2
echo -e "${GREEN}>>> Menjalankan aplikasi dengan PM2...${NC}"
pm2 delete dino-bill 2>/dev/null
pm2 start server.js --name "dino-bill"
pm2 save
pm2 startup

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}      Instalasi Selesai & Berhasil!       ${NC}"
echo -e "${YELLOW} Akses Web Installer: http://$(hostname -I | awk '{print $1}'):3999 ${NC}"
echo -e "${GREEN}==========================================${NC}"