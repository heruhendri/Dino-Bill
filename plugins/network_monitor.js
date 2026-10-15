/**
 * Plugin: Network Real-time Monitor
 * Description: Premium real-time traffic monitoring for MikroTik
 */

module.exports = function(app, pool, { requireAuth, requireRole }) {
    
    // 1. Add Navigation Link to Sidebar (Dynamic via Client-side JS or Middleware)
    // For simplicity, we'll just register the route
    
    app.get('/network-monitor', requireAuth, async (req, res) => {
        try {
            const [routers] = await pool.query("SELECT * FROM routers WHERE status = 'active'");
            res.render('network_monitor_dashboard', { 
                user: req.session, 
                routers,
                currentPage: 'network-monitor' 
            });
        } catch (e) {
            res.status(500).send(e.message);
        }
    });

    // 2. Create the View (EJS) dynamically if it doesn't exist
    // In a real plugin system, we'd package this. Here we'll inject it.
    const fs = require('fs');
    const path = require('path');
    const viewPath = path.join(__dirname, '..', 'views', 'network_monitor_dashboard.ejs');
    
    const viewContent = `
<%- include('partials/header') %>
<div class="container-fluid py-4">
    <div class="row mb-4">
        <div class="col-12">
            <div class="card bg-dark border-0 shadow-lg overflow-hidden" style="border-radius: 20px;">
                <div class="card-body p-4">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <h4 class="text-white mb-1">Network Real-time Monitor 🚀</h4>
                            <p class="text-secondary mb-0">Pantau performa jaringan Anda secara langsung.</p>
                        </div>
                        <div class="d-flex gap-2">
                            <select id="routerSelect" class="form-select bg-dark text-white border-secondary" style="width: 200px; border-radius: 10px;">
                                <% routers.forEach(r => { %>
                                    <option value="<%= r.id %>"><%= r.name %></option>
                                <% }) %>
                            </select>
                            <input type="text" id="interfaceInput" class="form-control bg-dark text-white border-secondary" value="ether1" style="width: 120px; border-radius: 10px;" placeholder="Interface">
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="row">
        <div class="col-lg-8">
            <div class="card bg-dark border-0 shadow-lg mb-4" style="border-radius: 20px;">
                <div class="card-header bg-transparent border-0 pt-4 px-4">
                    <h6 class="text-white">Traffic Throughput (Mbps)</h6>
                </div>
                <div class="card-body p-4">
                    <div style="height: 400px;">
                        <canvas id="trafficChart"></canvas>
                    </div>
                </div>
            </div>
        </div>
        <div class="col-lg-4">
            <div class="row">
                <div class="col-12 mb-4">
                    <div class="card bg-primary border-0 shadow-lg" style="border-radius: 20px; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);">
                        <div class="card-body p-4">
                            <h6 class="text-white opacity-75">Current Download</h6>
                            <h2 class="text-white mb-0" id="currentRx">0.00 Mbps</h2>
                        </div>
                    </div>
                </div>
                <div class="col-12 mb-4">
                    <div class="card bg-info border-0 shadow-lg" style="border-radius: 20px; background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);">
                        <div class="card-body p-4">
                            <h6 class="text-white opacity-75">Current Upload</h6>
                            <h2 class="text-white mb-0" id="currentTx">0.00 Mbps</h2>
                        </div>
                    </div>
                </div>
                <div class="col-12">
                    <div class="card bg-dark border-0 shadow-lg" style="border-radius: 20px;">
                        <div class="card-body p-4">
                            <h6 class="text-white mb-3">Saran Optimasi</h6>
                            <div class="d-flex align-items-center mb-3">
                                <div class="bg-success rounded-circle p-2 me-3">
                                    <i class="fas fa-check text-white" style="font-size: 10px;"></i>
                                </div>
                                <p class="text-secondary small mb-0">Latency terpantau stabil di bawah 20ms.</p>
                            </div>
                            <div class="d-flex align-items-center">
                                <div class="bg-warning rounded-circle p-2 me-3">
                                    <i class="fas fa-exclamation text-white" style="font-size: 10px;"></i>
                                </div>
                                <p class="text-secondary small mb-0">Penggunaan CPU Router > 60% saat traffic peak.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
    const ctx = document.getElementById('trafficChart').getContext('2d');
    const MAX_DATA_POINTS = 30;
    const labels = Array(MAX_DATA_POINTS).fill('');
    const rxData = Array(MAX_DATA_POINTS).fill(0);
    const txData = Array(MAX_DATA_POINTS).fill(0);

    const trafficChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Download (Rx)',
                    data: rxData,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    fill: true,
                    tension: 0.4,
                    borderWidth: 3,
                    pointRadius: 0
                },
                {
                    label: 'Upload (Tx)',
                    data: txData,
                    borderColor: '#06b6d4',
                    backgroundColor: 'rgba(6, 182, 212, 0.1)',
                    fill: true,
                    tension: 0.4,
                    borderWidth: 3,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', callback: (v) => v + ' Mbps' }
                },
                x: {
                    grid: { display: false },
                    ticks: { display: false }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#fff', usePointStyle: true, boxWidth: 10 }
                }
            }
        }
    });

    async function updateTraffic() {
        const routerId = document.getElementById('routerSelect').value;
        const iface = document.getElementById('interfaceInput').value;

        try {
            const res = await fetch(\`/api/mikrotik/traffic?interface=\${iface}&router=\${routerId}\`);
            const json = await res.json();
            
            if (json.success && json.data.length > 0) {
                // Find data for selected router
                const data = json.data.find(d => d.router_id == routerId) || json.data[0];
                
                const rxMbps = (data.rx / 1000000).toFixed(2);
                const txMbps = (data.tx / 1000000).toFixed(2);

                document.getElementById('currentRx').innerText = rxMbps + ' Mbps';
                document.getElementById('currentTx').innerText = txMbps + ' Mbps';

                // Update Chart
                rxData.push(rxMbps);
                txData.push(txMbps);
                
                if (rxData.length > MAX_DATA_POINTS) {
                    rxData.shift();
                    txData.shift();
                }

                trafficChart.update('none');
            }
        } catch (e) {
            console.error('Traffic Fetch Error:', e);
        }
    }

    setInterval(updateTraffic, 5000); // Update every 5 seconds (optimized for STB)
</script>
<%- include('partials/footer') %>
    `;

    if (!fs.existsSync(viewPath)) {
        fs.writeFileSync(viewPath, viewContent);
    }
    
    console.log("[Plugin] Network Monitor Initialized!");
};
