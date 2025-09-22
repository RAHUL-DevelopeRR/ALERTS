// Tamil Nadu Weather Alert System Application Data
const applicationData = {
  "alerts": [
    {
      "id": "TN-ALT001",
      "type": "Phase C Breakage - Thunderstorm",
      "location": "Between Pole 1 and 2, Coimbatore District (11.0168° N, 76.9558° E)",
      "timestamp": "2025-09-22T11:50:09",
      "status": "Active",
      "priority": "High",
      "description": "Breakage on Phase C detected due to thunderstorm. Dispatch drone/team for visual check. Cross-check impedance data.",
      "estimated_repair": "4-6 hours",
      "affected_consumers": 2800,
      "feeder": "Coimbatore North Feeder-3",
      "weather_cause": "Thunderstorm",
      "wind_speed": "45 km/h",
      "rainfall": "Heavy (>115mm/day)",
      "weather_icon": "⛈️"
    },
    {
      "id": "TN-ALT002",
      "type": "Line Trip - Tree Fall",
      "location": "Nilgiris District - Ooty-Coonoor 11kV Line",
      "timestamp": "2025-09-22T13:15:30",
      "status": "Under Investigation",
      "priority": "High",
      "description": "11kV transmission line tripped due to tree fall caused by heavy winds and rain. Emergency restoration team deployed.",
      "estimated_repair": "6-8 hours",
      "affected_consumers": 4200,
      "feeder": "Ooty Main Feeder",
      "weather_cause": "Heavy Rainfall + Wind",
      "wind_speed": "55 km/h",
      "rainfall": "Very Heavy (>204mm/day)",
      "weather_icon": "🌳💨"
    },
    {
      "id": "TN-ALT003",
      "type": "Transformer Damage - Lightning Strike",
      "location": "Dindigul District - Batlagundu Substation",
      "timestamp": "2025-09-22T14:45:12",
      "status": "Active",
      "priority": "High",
      "description": "Distribution transformer damaged due to direct lightning strike. Replacement transformer being mobilized.",
      "estimated_repair": "8-12 hours",
      "affected_consumers": 1850,
      "feeder": "Batlagundu Rural Feeder-2",
      "weather_cause": "Lightning Strike",
      "wind_speed": "38 km/h",
      "rainfall": "Moderate (65-115mm/day)",
      "weather_icon": "⚡"
    },
    {
      "id": "TN-ALT004",
      "type": "Cable Fault - Flooding",
      "location": "Chennai - Velachery Underground Cable Network",
      "timestamp": "2025-09-22T16:20:45",
      "status": "Resolved",
      "priority": "Medium",
      "description": "Underground cable fault due to water logging resolved. Pumping operations completed and service restored.",
      "estimated_repair": "Completed",
      "affected_consumers": 0,
      "feeder": "Velachery Commercial Feeder-1",
      "weather_cause": "Heavy Rainfall + Flooding",
      "wind_speed": "25 km/h",
      "rainfall": "Heavy (>115mm/day)",
      "weather_icon": "🌊"
    },
    {
      "id": "TN-ALT005",
      "type": "Multiple Line Fault - Cyclone Alert",
      "location": "Nagapattinam Coastal District - Multiple 33kV Lines",
      "timestamp": "2025-09-22T18:30:00",
      "status": "Scheduled Shutdown",
      "priority": "High",
      "description": "Preventive shutdown of coastal transmission lines due to cyclone warning. Lines will be restored post storm clearance.",
      "estimated_repair": "24-48 hours",
      "affected_consumers": 15000,
      "feeder": "Nagapattinam Coastal Network",
      "weather_cause": "Cyclone Warning",
      "wind_speed": "85 km/h expected",
      "rainfall": "Extremely Heavy (>204mm/day) expected",
      "weather_icon": "🌀"
    }
  ],
  "service_stats": {
    "total_consumers": 8500000,
    "active_feeders": 1860,
    "substations": 485,
    "current_load": "12500 MW",
    "peak_load_today": "15200 MW",
    "system_availability": "98.8%",
    "active_weather_alerts": 2,
    "resolved_today": 8,
    "preventive_shutdowns": 1,
    "weather_stations_monitoring": 437,
    "emergency_response_teams": 125
  },
  "districts": [
    {"district": "Chennai", "consumers": 2500000, "feeders": 320, "current_alerts": 1, "weather_risk": "High"},
    {"district": "Coimbatore", "consumers": 890000, "feeders": 185, "current_alerts": 1, "weather_risk": "High"},
    {"district": "Madurai", "consumers": 750000, "feeders": 145, "current_alerts": 0, "weather_risk": "Medium"},
    {"district": "Tiruchirappalli", "consumers": 680000, "feeders": 125, "current_alerts": 0, "weather_risk": "Medium"},
    {"district": "Salem", "consumers": 620000, "feeders": 115, "current_alerts": 0, "weather_risk": "Low"},
    {"district": "Tirunelveli", "consumers": 580000, "feeders": 105, "current_alerts": 0, "weather_risk": "High"},
    {"district": "Erode", "consumers": 520000, "feeders": 95, "current_alerts": 0, "weather_risk": "Medium"},
    {"district": "Vellore", "consumers": 480000, "feeders": 88, "current_alerts": 0, "weather_risk": "Low"},
    {"district": "Dindigul", "consumers": 450000, "feeders": 82, "current_alerts": 1, "weather_risk": "High"},
    {"district": "Thanjavur", "consumers": 420000, "feeders": 78, "current_alerts": 0, "weather_risk": "Medium"},
    {"district": "Nilgiris", "consumers": 185000, "feeders": 45, "current_alerts": 1, "weather_risk": "Very High"},
    {"district": "Nagapattinam", "consumers": 350000, "feeders": 65, "current_alerts": 1, "weather_risk": "Very High"},
    {"district": "Kanyakumari", "consumers": 320000, "feeders": 58, "current_alerts": 0, "weather_risk": "High"},
    {"district": "Theni", "consumers": 280000, "feeders": 52, "current_alerts": 0, "weather_risk": "High"}
  ],
  "emergency_contacts": {
    "minnagam_24x7": "94987 94987",
    "power_failure": "1912",
    "emergency_toll_free": "1800-180-8752",
    "whatsapp_support": "94458-50811"
  },
  "weather_monitoring": {
    "systems_deployed": 437,
    "sms_capability": "2 crore users",
    "disaster_response_teams": 9,
    "personnel_deployed": 296
  },
  "last_updated": "2025-09-22 20:20:28"
};

// Global variables
let currentFilter = 'all';
let filteredAlerts = [...applicationData.alerts];

// Initialize application when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
  initializeApp();
});

function initializeApp() {
  renderWeatherAlerts();
  renderDistricts();
  setupEventListeners();
  updateTimestamp();
  updateAlertCount();
  updateTickerTime();
  
  // Update timestamp every minute
  setInterval(updateTimestamp, 60000);
  
  // Update ticker time every 30 seconds
  setInterval(updateTickerTime, 30000);
}

function setupEventListeners() {
  // Alert filter buttons
  const filterButtons = document.querySelectorAll('.filter-btn');
  filterButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const filter = e.target.dataset.filter;
      setActiveFilter(filter);
      filterWeatherAlerts(filter);
    });
  });

  // District search
  const districtSearch = document.getElementById('districtSearch');
  if (districtSearch) {
    districtSearch.addEventListener('input', (e) => {
      searchDistricts(e.target.value);
    });
  }

  // SMS Registration form
  const smsForm = document.getElementById('smsRegistrationForm');
  if (smsForm) {
    smsForm.addEventListener('submit', handleSMSRegistration);
  }

  // Service cards click handlers
  const serviceCards = document.querySelectorAll('.service-card');
  serviceCards.forEach(card => {
    card.addEventListener('click', () => {
      const serviceName = card.querySelector('h4').textContent;
      handleServiceClick(serviceName);
    });
  });

  // Quick action buttons
  const quickActionButtons = document.querySelectorAll('.quick-actions .btn');
  quickActionButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      handleQuickAction(e.target.textContent.trim());
    });
  });

  // Monitor cards click handlers
  const monitorCards = document.querySelectorAll('.monitor-card');
  monitorCards.forEach(card => {
    card.addEventListener('click', () => {
      const monitorType = card.querySelector('h4').textContent;
      handleMonitorClick(monitorType);
    });
  });
}

function renderWeatherAlerts() {
  const alertsContainer = document.getElementById('weatherAlertsContainer');
  if (!alertsContainer) return;

  alertsContainer.innerHTML = '';

  if (filteredAlerts.length === 0) {
    alertsContainer.innerHTML = '<div class="no-alerts" style="text-align: center; padding: 20px; color: var(--color-text-secondary); font-style: italic;">No weather alerts found for the selected filter.</div>';
    return;
  }

  filteredAlerts.forEach(alert => {
    const alertCard = createWeatherAlertCard(alert);
    alertsContainer.appendChild(alertCard);
  });
}

function createWeatherAlertCard(alert) {
  const card = document.createElement('div');
  const priorityClass = alert.status === 'Resolved' ? 'resolved' : 
                       alert.status === 'Scheduled Shutdown' ? 'preventive' : 'critical';
  
  card.className = `weather-alert-card ${priorityClass}`;
  card.dataset.alertId = alert.id;

  const statusClass = getWeatherStatusClass(alert.status);
  const formattedTime = formatTimestamp(alert.timestamp);
  const mapsUrl = generateMapsUrl(alert.location);

  card.innerHTML = `
    <div class="weather-alert-header">
      <div class="weather-type">
        <span class="weather-icon">${alert.weather_icon}</span>
        ${alert.type}
      </div>
      <div class="weather-status ${statusClass}">${alert.status}</div>
    </div>
    <div class="weather-info-grid">
      <div class="weather-info-item">
        <span class="weather-info-label">Location:</span>
        <span class="weather-info-value">${alert.location.split('(')[0]}</span>
      </div>
      <div class="weather-info-item">
        <span class="weather-info-label">Time:</span>
        <span class="weather-info-value">${formattedTime}</span>
      </div>
      <div class="weather-info-item">
        <span class="weather-info-label">Affected Consumers:</span>
        <span class="weather-info-value">${alert.affected_consumers.toLocaleString()}</span>
      </div>
      <div class="weather-info-item">
        <span class="weather-info-label">Estimated Repair:</span>
        <span class="weather-info-value">${alert.estimated_repair}</span>
      </div>
    </div>
    <div class="weather-conditions">
      <strong>Weather Cause:</strong> ${alert.weather_cause} | 
      <strong>Wind:</strong> ${alert.wind_speed} | 
      <strong>Rainfall:</strong> ${alert.rainfall}
    </div>
    <div class="weather-description">${alert.description}</div>
    <div class="weather-actions">
      <button class="weather-btn" onclick="viewWeatherDetails('${alert.id}')">View Details</button>
      <button class="weather-btn" onclick="trackWeatherProgress('${alert.id}')">Track Progress</button>
      <button class="weather-btn maps-btn" onclick="openGoogleMaps('${mapsUrl}')">View on Google Maps</button>
    </div>
  `;

  // Add click handler to the entire card
  card.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    handleWeatherAlertClick(alert);
  });

  return card;
}

function openGoogleMaps(url) {
  window.open(url, '_blank');
}

function generateMapsUrl(location) {
  // Extract coordinates if available, otherwise use location name
  const coordMatch = location.match(/\(([0-9.]+)°\s*N,\s*([0-9.]+)°\s*E\)/);
  if (coordMatch) {
    const lat = coordMatch[1];
    const lng = coordMatch[2];
    return `https://www.google.com/maps?q=${lat},${lng}`;
  } else {
    const locationName = location.split('(')[0].trim();
    return `https://www.google.com/maps/search/${encodeURIComponent(locationName)}`;
  }
}

function getWeatherStatusClass(status) {
  const statusMap = {
    'Active': 'status-active',
    'Resolved': 'status-resolved',
    'Scheduled Shutdown': 'status-scheduled-shutdown',
    'Under Investigation': 'status-under-investigation'
  };
  return statusMap[status] || 'status-active';
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function setActiveFilter(filter) {
  currentFilter = filter;
  const filterButtons = document.querySelectorAll('.filter-btn');
  filterButtons.forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.filter === filter) {
      btn.classList.add('active');
    }
  });
}

function filterWeatherAlerts(filter) {
  console.log('Filtering weather alerts by:', filter);
  
  if (filter === 'all') {
    filteredAlerts = [...applicationData.alerts];
  } else if (filter === 'Active') {
    filteredAlerts = applicationData.alerts.filter(alert => alert.status === 'Active');
  } else if (filter === 'Resolved') {
    filteredAlerts = applicationData.alerts.filter(alert => alert.status === 'Resolved');
  } else if (filter === 'Scheduled Shutdown') {
    filteredAlerts = applicationData.alerts.filter(alert => alert.status === 'Scheduled Shutdown');
  } else if (filter === 'Under Investigation') {
    filteredAlerts = applicationData.alerts.filter(alert => alert.status === 'Under Investigation');
  } else {
    // For any other filter, try exact match
    filteredAlerts = applicationData.alerts.filter(alert => alert.status === filter);
  }
  
  console.log('Filtered alerts:', filteredAlerts.length);
  renderWeatherAlerts();
}

function renderDistricts() {
  const districtList = document.getElementById('districtList');
  if (!districtList) return;

  districtList.innerHTML = '';

  applicationData.districts.forEach(district => {
    const districtItem = createDistrictWeatherItem(district);
    districtList.appendChild(districtItem);
  });
}

function createDistrictWeatherItem(district) {
  const item = document.createElement('div');
  item.className = 'district-weather-item';
  item.dataset.district = district.district.toLowerCase();

  const riskClass = district.weather_risk.toLowerCase().replace(' ', '-');
  const alertsText = district.current_alerts > 0 ? district.current_alerts : '0';

  item.innerHTML = `
    <div class="district-info">
      <h4>${district.district}</h4>
      <div class="district-stats">${district.consumers.toLocaleString()} consumers • ${district.feeders} feeders</div>
    </div>
    <div class="weather-risk">
      <div class="risk-level ${riskClass}">${district.weather_risk} Risk</div>
      <div class="alert-badge ${district.current_alerts === 0 ? 'no-alerts' : ''}">${alertsText} alerts</div>
    </div>
  `;

  item.addEventListener('click', () => handleDistrictWeatherClick(district));

  return item;
}

function searchDistricts(query) {
  const districtItems = document.querySelectorAll('.district-weather-item');
  const searchTerm = query.toLowerCase();

  districtItems.forEach(item => {
    const districtName = item.dataset.district;
    if (districtName.includes(searchTerm)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
}

function updateTimestamp() {
  const lastUpdatedElement = document.getElementById('lastUpdated');
  if (lastUpdatedElement) {
    const now = new Date();
    const formattedTime = now.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).replace(/(\d+)\/(\d+)\/(\d+),?\s*(.+)/, '$3-$1-$2 $4');
    
    lastUpdatedElement.textContent = formattedTime;
  }
}

function updateTickerTime() {
  const tickerTimeElement = document.getElementById('tickerTime');
  if (tickerTimeElement) {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    tickerTimeElement.textContent = `Updated at ${timeString} IST`;
  }
}

function updateAlertCount() {
  const alertCountElement = document.getElementById('alertCount');
  if (alertCountElement) {
    const activeAlerts = applicationData.alerts.filter(alert => 
      alert.status === 'Active' || alert.status === 'Under Investigation'
    ).length;
    alertCountElement.textContent = activeAlerts;
  }
}

// Event handlers
function handleWeatherAlertClick(alert) {
  console.log('Weather alert clicked:', alert);
  showWeatherAlertDetails(alert);
}

function showWeatherAlertDetails(alert) {
  const existingModal = document.querySelector('.weather-modal');
  if (existingModal) {
    existingModal.remove();
  }

  const modal = document.createElement('div');
  modal.className = 'weather-modal';
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeWeatherModal()"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h3>${alert.weather_icon} ${alert.type} - ${alert.id}</h3>
        <button class="modal-close" onclick="closeWeatherModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="weather-detail-grid">
          <div class="detail-item">
            <strong>Status:</strong>
            <span class="weather-status ${getWeatherStatusClass(alert.status)}">${alert.status}</span>
          </div>
          <div class="detail-item">
            <strong>Priority:</strong>
            <span>${alert.priority}</span>
          </div>
          <div class="detail-item">
            <strong>Location:</strong>
            <span>${alert.location}</span>
          </div>
          <div class="detail-item">
            <strong>Feeder:</strong>
            <span>${alert.feeder}</span>
          </div>
          <div class="detail-item">
            <strong>Timestamp:</strong>
            <span>${formatTimestamp(alert.timestamp)}</span>
          </div>
          <div class="detail-item">
            <strong>Affected Consumers:</strong>
            <span>${alert.affected_consumers.toLocaleString()}</span>
          </div>
          <div class="detail-item">
            <strong>Weather Cause:</strong>
            <span>${alert.weather_cause}</span>
          </div>
          <div class="detail-item">
            <strong>Wind Speed:</strong>
            <span>${alert.wind_speed}</span>
          </div>
          <div class="detail-item">
            <strong>Rainfall:</strong>
            <span>${alert.rainfall}</span>
          </div>
          <div class="detail-item">
            <strong>Estimated Repair Time:</strong>
            <span>${alert.estimated_repair}</span>
          </div>
        </div>
        <div class="weather-conditions">
          <strong>Weather Description:</strong>
          <p>${alert.description}</p>
        </div>
        <div class="modal-actions">
          <button class="btn btn--primary" onclick="trackWeatherProgress('${alert.id}')">Track Progress</button>
          <button class="btn btn--secondary" onclick="openGoogleMaps('${generateMapsUrl(alert.location)}')">View on Maps</button>
          <button class="btn btn--outline" onclick="closeWeatherModal()">Close</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  
  // Add escape key handler
  const handleEscape = (e) => {
    if (e.key === 'Escape') {
      closeWeatherModal();
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);
}

function closeWeatherModal() {
  const modal = document.querySelector('.weather-modal');
  if (modal) {
    modal.remove();
  }
}

function viewWeatherDetails(alertId) {
  const alert = applicationData.alerts.find(a => a.id === alertId);
  if (alert) {
    showWeatherAlertDetails(alert);
  }
}

function trackWeatherProgress(alertId) {
  const alert = applicationData.alerts.find(a => a.id === alertId);
  if (alert) {
    const progressSteps = getWeatherProgressSteps(alert);
    
    const modal = document.createElement('div');
    modal.className = 'weather-modal';
    modal.innerHTML = `
      <div class="modal-overlay" onclick="closeWeatherModal()"></div>
      <div class="modal-content">
        <div class="modal-header">
          <h3>${alert.weather_icon} Weather Progress - ${alert.id}</h3>
          <button class="modal-close" onclick="closeWeatherModal()">×</button>
        </div>
        <div class="modal-body">
          <div class="progress-timeline">
            ${progressSteps.map(step => `
              <div class="progress-step ${step.completed ? 'completed' : 'pending'}">
                <div class="step-indicator">${step.completed ? '✓' : '⏳'}</div>
                <div class="step-content">
                  <div class="step-title">${step.title}</div>
                  <div class="step-time">${step.time}</div>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="modal-actions">
            <button class="btn btn--outline" onclick="closeWeatherModal()">Close</button>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal
    const existingModal = document.querySelector('.weather-modal');
    if (existingModal) {
      existingModal.remove();
    }

    document.body.appendChild(modal);
  }
}

function getWeatherProgressSteps(alert) {
  const baseSteps = [
    { title: 'Weather incident detected', completed: true, time: formatTimestamp(alert.timestamp) },
    { title: 'Weather monitoring system activated', completed: true, time: 'Immediately after detection' },
    { title: 'Emergency response team alerted', completed: true, time: 'Within 5 minutes' }
  ];

  if (alert.status === 'Active') {
    return [
      ...baseSteps,
      { title: 'Weather assessment team dispatched', completed: true, time: 'Within 15 minutes' },
      { title: 'Site safety evaluation in progress', completed: false, time: 'In progress' },
      { title: 'Weather-safe repair work initiated', completed: false, time: 'Pending weather clearance' },
      { title: 'Power restoration', completed: false, time: `Expected: ${alert.estimated_repair}` }
    ];
  } else if (alert.status === 'Resolved') {
    return [
      ...baseSteps,
      { title: 'Weather assessment completed', completed: true, time: 'Completed' },
      { title: 'Site declared safe for repair', completed: true, time: 'Completed' },
      { title: 'Repair work completed', completed: true, time: 'Completed' },
      { title: 'Power fully restored', completed: true, time: 'Completed' }
    ];
  } else if (alert.status === 'Scheduled Shutdown') {
    return [
      { title: 'Weather warning received', completed: true, time: formatTimestamp(alert.timestamp) },
      { title: 'Preventive shutdown planned', completed: true, time: 'Emergency protocol activated' },
      { title: 'Consumer notifications sent', completed: true, time: 'Advance notice provided' },
      { title: 'Weather monitoring active', completed: false, time: 'Continuous monitoring' },
      { title: 'Post-weather safety assessment', completed: false, time: 'After weather clearance' },
      { title: 'Service restoration', completed: false, time: `Expected: ${alert.estimated_repair}` }
    ];
  } else {
    return [
      ...baseSteps,
      { title: 'Weather damage assessment', completed: false, time: 'In progress' },
      { title: 'Safety evaluation ongoing', completed: false, time: 'Pending weather conditions' },
      { title: 'Repair strategy planning', completed: false, time: 'Pending' }
    ];
  }
}

function handleDistrictWeatherClick(district) {
  const modal = document.createElement('div');
  modal.className = 'weather-modal';
  
  const districtAlerts = applicationData.alerts.filter(alert => 
    alert.location.includes(district.district)
  );

  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeWeatherModal()"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h3>${district.district} District Weather Status</h3>
        <button class="modal-close" onclick="closeWeatherModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="weather-detail-grid">
          <div class="detail-item">
            <strong>Total Consumers:</strong>
            <span>${district.consumers.toLocaleString()}</span>
          </div>
          <div class="detail-item">
            <strong>Active Feeders:</strong>
            <span>${district.feeders}</span>
          </div>
          <div class="detail-item">
            <strong>Weather Risk Level:</strong>
            <span class="risk-level ${district.weather_risk.toLowerCase().replace(' ', '-')}">${district.weather_risk}</span>
          </div>
          <div class="detail-item">
            <strong>Current Weather Alerts:</strong>
            <span class="${district.current_alerts > 0 ? 'alert-count-positive' : 'alert-count-zero'}">
              ${district.current_alerts}
            </span>
          </div>
        </div>
        ${districtAlerts.length > 0 ? `
          <div class="detail-description">
            <strong>Active Weather Alerts in ${district.district}:</strong>
            <ul>
              ${districtAlerts.map(alert => `
                <li>${alert.weather_icon} ${alert.type} - ${alert.weather_cause} (${alert.status})</li>
              `).join('')}
            </ul>
          </div>
        ` : `
          <div class="detail-description">
            <strong>No active weather alerts in ${district.district}</strong>
            <p>All systems operating normally. Weather monitoring systems active.</p>
          </div>
        `}
        <div class="modal-actions">
          <button class="btn btn--primary">SMS Weather Alerts</button>
          <button class="btn btn--secondary">Emergency Contacts</button>
          <button class="btn btn--outline" onclick="closeWeatherModal()">Close</button>
        </div>
      </div>
    </div>
  `;

  const existingModal = document.querySelector('.weather-modal');
  if (existingModal) {
    existingModal.remove();
  }

  document.body.appendChild(modal);
}

function handleSMSRegistration(e) {
  e.preventDefault();
  
  const mobileNumber = document.getElementById('mobileNumber').value;
  const district = document.getElementById('district').value;
  
  if (!mobileNumber || !district) {
    alert('Please fill in all required fields.');
    return;
  }
  
  // Simulate SMS registration
  const modal = document.createElement('div');
  modal.className = 'weather-modal';
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeWeatherModal()"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h3>📱 SMS Weather Alert Registration</h3>
        <button class="modal-close" onclick="closeWeatherModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="status status--success" style="margin-bottom: 16px;">
          Registration Successful!
        </div>
        <p><strong>Mobile Number:</strong> ${mobileNumber}</p>
        <p><strong>District:</strong> ${district}</p>
        <p>You will now receive real-time SMS alerts for weather-related power outages in ${district} district.</p>
        <p><strong>Alert Types:</strong></p>
        <ul>
          <li>⛈️ Thunderstorm and lightning warnings</li>
          <li>🌧️ Heavy rainfall alerts</li>
          <li>💨 High wind speed warnings</li>
          <li>🌀 Cyclone and severe weather alerts</li>
          <li>⚡ Power outage notifications</li>
          <li>🔄 Service restoration updates</li>
        </ul>
        <div class="modal-actions">
          <button class="btn btn--outline" onclick="closeWeatherModal()">Close</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  
  // Reset form
  document.getElementById('smsRegistrationForm').reset();
}

function handleServiceClick(serviceName) {
  console.log('Weather service clicked:', serviceName);
  
  const serviceInfo = {
    'SMS Weather Alerts': 'Register to receive real-time SMS notifications about weather-related power outages, including thunderstorms, heavy rainfall, high winds, and cyclone warnings.',
    'Storm Damage Report': 'Report weather-related infrastructure damage including fallen trees on power lines, damaged transformers, or cable faults caused by storms.',
    'Area Weather Status': 'Check current weather conditions, active weather warnings, and power outage status in your specific area or district.',
    'Emergency Hotline': 'Access 24x7 emergency support for weather-related power issues. Our Minnagam helpline provides immediate assistance during severe weather events.',
    'WhatsApp Support': 'Get weather alerts and emergency support through WhatsApp. Send your location to receive area-specific weather and outage updates.',
    'Push Notifications': 'Enable push notifications on the TANGEDCO mobile app to receive instant alerts for weather warnings and power outage updates.'
  };

  const modal = document.createElement('div');
  modal.className = 'weather-modal';
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeWeatherModal()"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h3>${serviceName}</h3>
        <button class="modal-close" onclick="closeWeatherModal()">×</button>
      </div>
      <div class="modal-body">
        <p>${serviceInfo[serviceName] || 'Weather service information not available.'}</p>
        <div class="modal-actions">
          <button class="btn btn--primary">Access Service</button>
          <button class="btn btn--outline" onclick="closeWeatherModal()">Close</button>
        </div>
      </div>
    </div>
  `;

  const existingModal = document.querySelector('.weather-modal');
  if (existingModal) {
    existingModal.remove();
  }

  document.body.appendChild(modal);
}

function handleQuickAction(actionName) {
  console.log('Quick action clicked:', actionName);
  
  const actionInfo = {
    'Report Weather Damage': 'Report weather-related power infrastructure damage in your area. Include details about the type of damage, location, and current weather conditions.',
    'Check My Area': 'Enter your location to check current weather conditions, active weather warnings, and power supply status in your area.',
    'Emergency Contact': 'Access emergency contact numbers for immediate assistance during severe weather events and power outages.',
    'Weather Updates': 'Get the latest weather forecasts, warnings, and advisories from the India Meteorological Department for Tamil Nadu.'
  };

  const modal = document.createElement('div');
  modal.className = 'weather-modal';
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeWeatherModal()"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h3>${actionName}</h3>
        <button class="modal-close" onclick="closeWeatherModal()">×</button>
      </div>
      <div class="modal-body">
        <p>${actionInfo[actionName]}</p>
        ${actionName === 'Emergency Contact' ? `
          <div class="weather-detail-grid">
            <div class="detail-item">
              <strong>Minnagam 24x7:</strong>
              <span><a href="tel:9498794987">94987 94987</a></span>
            </div>
            <div class="detail-item">
              <strong>Power Failure:</strong>
              <span><a href="tel:1912">1912</a></span>
            </div>
            <div class="detail-item">
              <strong>Emergency Toll-Free:</strong>
              <span><a href="tel:18001808752">1800-180-8752</a></span>
            </div>
            <div class="detail-item">
              <strong>WhatsApp Support:</strong>
              <span><a href="https://wa.me/919445850811" target="_blank">94458-50811</a></span>
            </div>
          </div>
        ` : ''}
        <div class="modal-actions">
          <button class="btn btn--primary">Proceed</button>
          <button class="btn btn--outline" onclick="closeWeatherModal()">Close</button>
        </div>
      </div>
    </div>
  `;

  const existingModal = document.querySelector('.weather-modal');
  if (existingModal) {
    existingModal.remove();
  }

  document.body.appendChild(modal);
}

function handleMonitorClick(monitorType) {
  console.log('Weather monitor clicked:', monitorType);
  
  const monitorDetails = {
    'Temperature': 'Current temperature readings from weather stations across Tamil Nadu. Normal range: 28-35°C',
    'Wind Speed': 'Real-time wind speed monitoring. Alert threshold: >40 km/h. Current high activity in coastal areas.',
    'Rainfall': 'Rainfall intensity measurements. Heavy rain (>115mm/day) can cause power infrastructure issues.',
    'Lightning Activity': 'Lightning strike detection system. High activity poses risk to transformers and power lines.',
    'Cyclone Warning': 'Active cyclone monitoring for coastal Tamil Nadu. Current warning for Nagapattinam district.',
    'Response Teams': 'Emergency response teams deployed across districts ready for weather-related power issues.'
  };

  const modal = document.createElement('div');
  modal.className = 'weather-modal';
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeWeatherModal()"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h3>Weather Monitoring: ${monitorType}</h3>
        <button class="modal-close" onclick="closeWeatherModal()">×</button>
      </div>
      <div class="modal-body">
        <p>${monitorDetails[monitorType]}</p>
        <p><strong>Data Source:</strong> India Meteorological Department (IMD) and TANGEDCO Weather Monitoring Network</p>
        <p><strong>Update Frequency:</strong> Every 15 minutes</p>
        <div class="modal-actions">
          <button class="btn btn--primary">View Detailed Data</button>
          <button class="btn btn--outline" onclick="closeWeatherModal()">Close</button>
        </div>
      </div>
    </div>
  `;

  const existingModal = document.querySelector('.weather-modal');
  if (existingModal) {
    existingModal.remove();
  }

  document.body.appendChild(modal);
}

// Initialize real-time weather simulation
setTimeout(() => {
  setInterval(() => {
    if (Math.random() > 0.85) {
      updateTimestamp();
      updateTickerTime();
      console.log('Weather system data refreshed');
    }
  }, 45000);
}, 10000);