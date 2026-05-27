#!/bin/bash

echo "🦖 Dino-Bill Auto Installer for Ubuntu"
echo "---------------------------------------"

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
INSTALL_NODE=false
if ! command -v node &> /dev/null; then
    INSTALL_NODE=true
else
    NODE_VER=$(node -v)
    echo "Node.js sudah terinstall: $NODE_VER"
    echo -n "Apakah Anda ingin menginstall ulang Node.js v18? (y/n): "
    read choice < /dev/tty
    if [[ "$choice" =~ ^[Yy]$ ]]; then
        INSTALL_NODE=true
    fi
fi

if [ "$INSTALL_NODE" = true ]; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install -y nodejs
fi

# Install MySQL
if ! command -v mysql &> /dev/null
then
    echo "Installing MySQL..."
    sudo apt install -y mysql-server
fi

# Install Git
sudo apt install -y git

# Install PM2
sudo npm install -g pm2

# Install WhatsApp engine dependencies
echo "Installing Google Chrome for WhatsApp engine..."
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

# Clone and Install App (If not exists)
if [ ! -d "Dino-Bill" ]; then
    echo "Cloning Dino-Bill repository..."
    git clone https://github.com/heruhendri/Dino-Bill.git
    cd Dino-Bill
    PUPPETEER_SKIP_DOWNLOAD=true npm install
else
    cd Dino-Bill
    git pull
    PUPPETEER_SKIP_DOWNLOAD=true npm install
fi

# Setup PM2
pm2 start server.js --name dino-bill
pm2 save
pm2 startup

echo "---------------------------------------"
echo "✅ Instalasi Selesai!"
echo "Akses Web Installer di http://$(hostname -I | awk '{print $1}'):3999"
echo "---------------------------------------"
echo "--------------------------------------"
