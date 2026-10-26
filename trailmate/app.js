const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyIVWns-JTgI36wiNTSBdC3wTjON41xIqSEg66qwBnLJW4-DeaFKldXRVtFPEzNj8IJKA/exec';

let map, gpxPolyline, startMarker, endMarker, syncMarker, elevationChart;
let parsedTrackPoints = [], waypoints = [], waypointMarkers = [];
let segmentsStats = [], isSegmentStatsVisible = true;
let currentRouteId = null;
let currentRouteOwner = null;
let refRouteGroup;
let tempSearchMarker = null;
let currentEditingWaypointIndex = -1; 
let routeToDeleteId = null; 
let isRouteModified = false; 

const HISTORY_KEY = 'gpx_search_history', HISTORY_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

const greenBtnClasses = ['bg-emerald-50', 'text-emerald-700', 'border-emerald-200', 'hover:bg-emerald-100'];
const grayBtnClasses = ['bg-slate-100', 'text-slate-400', 'border-slate-200', 'opacity-60', 'cursor-not-allowed'];

// 切換按鈕的啟用狀態與樣式外觀
function toggleActionBtn(btnId, enabled, title = "") {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = !enabled;
    btn.title = title;
    if (enabled) {
        btn.classList.remove(...grayBtnClasses);
        btn.classList.add(...greenBtnClasses);
    } else {
        btn.classList.remove(...greenBtnClasses);
        btn.classList.add(...grayBtnClasses);
    }
}

// 系統初始化，設定地圖、事件、拖曳排序、登入狀態及處理網址參數
function init() {
    initMap();
    setupEventListeners();
    setupSortable();
    checkLoginStatus();

    const urlParams = new URLSearchParams(window.location.search);
    const routeId = urlParams.get('id');
    if (routeId) {
        currentRouteId = routeId;
        loadRouteById(routeId);
    }
}

// 初始化航點列表的拖曳排序功能
function setupSortable() {
    const list = document.getElementById('waypoints-list');
    Sortable.create(list, {
        handle: '.drag-handle',
        animation: 150,
        ghostClass: 'sortable-ghost',
        onEnd: function (evt) {
            if (evt.oldIndex === evt.newIndex) return;
            isRouteModified = true; 
            const movedItem = waypoints.splice(evt.oldIndex, 1)[0];
            waypoints.splice(evt.newIndex, 0, movedItem);

            waypointMarkers.forEach(m => map.removeLayer(m));
            waypointMarkers = [];
            resetSegmentStats();
            
            clearTrack(); 

            const currentWps = [...waypoints];
            waypoints = [];
            currentWps.forEach(wp => addWaypoint(wp.lat, wp.lon, wp.name));
            updateWaypointsUI();
        }
    });
}

// 初始化地圖設定、圖層及綁定地圖相關事件
function initMap() {
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
    const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: 'Map data: &copy; OSM' });
    const rudyLayer = L.tileLayer('https://tile.happyman.idv.tw/map/moi_osm/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; Rudy' });

    map = L.map('map', { center: [25.0477214, 121.5171151], zoom: 12, layers: [osmLayer] });
    L.control.layers({ "OpenStreetMap": osmLayer, "魯地圖": rudyLayer, "OpenTopoMap": topoLayer }).addTo(map);

    const coordsDisplay = document.getElementById('mouse-coords');
    map.on('mousemove', e => {
        coordsDisplay.classList.remove('hidden');
        coordsDisplay.innerHTML = `緯度: ${e.latlng.lat.toFixed(5)}, 經度: ${e.latlng.lng.toFixed(5)}`;
    });
    map.on('mouseout', () => coordsDisplay.classList.add('hidden'));

    map.on('click', async e => {
        if (tempSearchMarker) {
            map.removeLayer(tempSearchMarker);
            tempSearchMarker = null;
        }

        const lat = e.latlng.lat, lon = e.latlng.lng;
        let pointName = `自訂點 (${lat.toFixed(3)}, ${lon.toFixed(3)})`, isRealLocation = false;

        document.getElementById('map').style.cursor = 'wait';
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18`);
            const data = await res.json();
            if (data && data.name) { pointName = data.name; isRealLocation = true; }
        } catch (err) {} finally { document.getElementById('map').style.cursor = ''; }

        previewLocation(lat, lon, pointName);
    });

    refRouteGroup = L.layerGroup().addTo(map);
}

// 綁定 UI 介面上所有監聽事件
function setupEventListeners() {
    document.getElementById('open-gpx-input').addEventListener('change', handleOpenGPX);
    document.getElementById('ref-gpx-file-input').addEventListener('change', handleRefFileUpload);

    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('focus', function() { if (this.value.trim() === '') showSearchHistory(); });
    searchInput.addEventListener('input', function() { if (this.value.trim() === '') showSearchHistory(); });
    document.addEventListener('click', e => { if (!e.target.closest('#search-container')) document.getElementById('search-results').innerHTML = ''; });
    
    document.getElementById('route-title').addEventListener('input', () => {
        isRouteModified = true;
        checkLoginStatus();
    });
}

// 處理參考用 GPX 檔案的上傳與解析
function handleRefFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const xmlDoc = new DOMParser().parseFromString(e.target.result, "text/xml");
            if (xmlDoc.querySelector('parsererror')) throw new Error("解析 GPX 錯誤。");

            let ptsNodes = xmlDoc.getElementsByTagName('trkpt');
            if (ptsNodes.length === 0) ptsNodes = xmlDoc.getElementsByTagName('rtept');
            if (ptsNodes.length === 0) ptsNodes = xmlDoc.getElementsByTagName('wpt');
            if (ptsNodes.length === 0) {
                const allNodes = xmlDoc.getElementsByTagName('*');
                const backupNodes = [];
                for (let i = 0; i < allNodes.length; i++) {
                    const tag = allNodes[i].tagName.toLowerCase();
                    if (tag.includes('trkpt') || tag.includes('rtept') || tag.includes('wpt')) {
                        backupNodes.push(allNodes[i]);
                    }
                }
                ptsNodes = backupNodes;
            }

            if (ptsNodes.length === 0) throw new Error("找不到可用的座標點。");

            let latlngs = [];
            for (let i = 0; i < ptsNodes.length; i++) {
                const lat = parseFloat(ptsNodes[i].getAttribute('lat'));
                const lon = parseFloat(ptsNodes[i].getAttribute('lon'));
                if (!isNaN(lat) && !isNaN(lon)) latlngs.push([lat, lon]);
            }

            if (latlngs.length === 0) throw new Error("無效座標。");
            if (!refRouteGroup) refRouteGroup = L.layerGroup().addTo(map);

            const refLine = L.polyline(latlngs, { color: '#3b82f6', weight: 5, opacity: 0.7, dashArray: '5, 8', lineCap: 'round' });
            refRouteGroup.addLayer(refLine);
            map.fitBounds(refLine.getBounds(), { padding: [50, 50] });
            document.getElementById('clear-ref-btn').classList.remove('hidden');
        } catch (err) {
            alert("讀取參考路線錯誤:\n" + err.message);
        } finally {
            document.getElementById('ref-gpx-file-input').value = '';
        }
    };
    reader.readAsText(file);
}

// 移除地圖上的參考路線圖層
function clearReferenceRoutes() {
    if (refRouteGroup) refRouteGroup.clearLayers();
    document.getElementById('clear-ref-btn').classList.add('hidden');
}

// 取得過去的搜尋紀錄
function getSearchHistory() {
    try {
        let history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        history = history.filter(item => (Date.now() - item.timestamp) < HISTORY_EXPIRY_MS);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        return history;
    } catch (e) { return []; }
}

// 儲存新的搜尋紀錄
function saveSearchHistory(name, lat, lon) {
    if (name.startsWith('自訂點')) return;
    let history = getSearchHistory().filter(item => item.name !== name);
    history.unshift({ name, lat, lon, timestamp: Date.now() });
    if (history.length > 10) history.pop();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

// 在搜尋列下方顯示搜尋歷史
function showSearchHistory() {
    const history = getSearchHistory(), resContainer = document.getElementById('search-results');
    resContainer.innerHTML = '';
    if (history.length === 0) return;
    resContainer.innerHTML = '<li class="p-2 text-[11px] font-bold text-slate-400 bg-slate-50 border-b border-slate-100 uppercase tracking-wider">最近搜尋紀錄 (30天內)</li>';
    history.forEach(item => {
        const li = document.createElement('li');
        li.className = 'p-2 hover:bg-emerald-50 cursor-pointer border-b text-sm flex justify-between items-center group';
        li.innerHTML = `<span class="truncate flex-1 text-slate-600 group-hover:text-emerald-700">${item.name}</span><span class="shrink-0 text-xs text-slate-400 group-hover:text-emerald-600">查看</span>`;
        li.onclick = () => {
            previewLocation(item.lat, item.lon, item.name);
            resContainer.innerHTML = ''; document.getElementById('search-input').value = '';
        };
        resContainer.appendChild(li);
    });
}

// 處理地名或地址搜尋
async function handleSearch() {
    const query = document.getElementById('search-input').value.trim();
    if (!query) return showSearchHistory();
    const resContainer = document.getElementById('search-results');
    resContainer.innerHTML = '<li class="p-2 text-xs text-slate-500 text-center">搜尋中...</li>';
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
        const data = await res.json();
        resContainer.innerHTML = data.length === 0 ? '<li class="p-2 text-xs text-slate-500 text-center">找不到結果</li>' : '';
        data.forEach(item => {
            const li = document.createElement('li');
            li.className = 'p-2 hover:bg-emerald-50 cursor-pointer border-b text-sm flex justify-between items-center group';
            const shortName = item.name || item.display_name.split(',')[0];
            li.innerHTML = `<span class="truncate flex-1 text-slate-700 group-hover:text-emerald-700">${item.display_name}</span><span class="shrink-0 text-xs text-slate-400 group-hover:text-emerald-600">查看</span>`;
            li.onclick = () => {
                previewLocation(parseFloat(item.lat), parseFloat(item.lon), shortName);
                resContainer.innerHTML = ''; document.getElementById('search-input').value = '';
            };
            resContainer.appendChild(li);
        });
    } catch (err) { resContainer.innerHTML = '<li class="p-2 text-xs text-rose-500 text-center">搜尋發生錯誤</li>'; }
}

// 在地圖上預覽搜尋結果或點擊位置
function previewLocation(lat, lon, name) {
    if (tempSearchMarker) map.removeLayer(tempSearchMarker);
    map.setView([lat, lon], 15);
    tempSearchMarker = L.marker([lat, lon]).addTo(map);

    const popupContent = document.createElement('div');
    popupContent.className = 'text-center p-1 min-w-[120px]';
    popupContent.innerHTML = `
        <div class="font-bold text-slate-700 text-sm mb-3">${name}</div>
        <button id="add-to-route-btn" class="w-full px-3 py-1.5 bg-emerald-600 text-white rounded text-xs font-bold hover:bg-emerald-700 transition shadow-sm">加入路線</button>
    `;
    popupContent.querySelector('#add-to-route-btn').onclick = () => {
        clearTrack(); 
        addWaypoint(lat, lon, name); 
        saveSearchHistory(name, lat, lon);
        if (tempSearchMarker) { map.removeLayer(tempSearchMarker); tempSearchMarker = null; }
    };
    tempSearchMarker.bindPopup(popupContent, { closeButton: true, minWidth: 140 }).openPopup();
}

// 重置路段數據與相關 UI
function resetSegmentStats() {
    segmentsStats = []; isSegmentStatsVisible = true;
    const textSpan = document.getElementById('toggle-segment-text');
    if (textSpan) textSpan.textContent = "隱藏路段";
}

// 加入新的航點並更新相關介面
function addWaypoint(lat, lon, name) {
    isRouteModified = true; 
    waypoints.push({ lat, lon, name });
    resetSegmentStats(); 
    updateWaypointsUI();
    const markerIcon = L.divIcon({ className: 'custom-div-icon', html: `<div style="background-color: #0f172a; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${waypoints.length}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    const marker = L.marker([lat, lon], {icon: markerIcon}).addTo(map).bindTooltip(name, {direction: 'top'});
    waypointMarkers.push(marker);
}

// 移除指定的航點
function removeWaypoint(index) {
    isRouteModified = true; 
    waypoints.splice(index, 1); 
    waypointMarkers.forEach(m => map.removeLayer(m)); 
    waypointMarkers = []; 
    resetSegmentStats();
    
    clearTrack(); 

    const currentWps = [...waypoints]; 
    waypoints = []; 
    currentWps.forEach(wp => addWaypoint(wp.lat, wp.lon, wp.name)); 
    updateWaypointsUI();
}

// 開啟航點名稱編輯模式
function editWaypointName(index) {
    currentEditingWaypointIndex = index;
    const input = document.getElementById('edit-waypoint-input');
    input.value = waypoints[index].name;
    
    document.getElementById('edit-waypoint-modal').classList.remove('hidden');
    
    setTimeout(() => {
        input.focus();
        input.select();
    }, 100);
}

// 關閉航點名稱編輯模式
function closeEditModal() {
    document.getElementById('edit-waypoint-modal').classList.add('hidden');
    currentEditingWaypointIndex = -1;
}

// 確定儲存修改後的航點名稱
function confirmEditWaypointName(event) {
    event.preventDefault();
    
    if (currentEditingWaypointIndex === -1) return;
    
    const index = currentEditingWaypointIndex;
    const input = document.getElementById('edit-waypoint-input');
    const newName = input.value.trim();
    
    if (newName !== "" && newName !== waypoints[index].name) {
        isRouteModified = true; 
        waypoints[index].name = newName;
        waypointMarkers[index].setTooltipContent(waypoints[index].name);
        saveSearchHistory(waypoints[index].name, waypoints[index].lat, waypoints[index].lon);
        updateWaypointsUI();
    }
    
    closeEditModal();
}

// 清除當前規劃的所有航點及路線
function clearRoute() {
    isRouteModified = false;
    waypoints = []; waypointMarkers.forEach(m => map.removeLayer(m)); waypointMarkers = [];
    resetSegmentStats(); clearTrack(); document.getElementById('route-title').value = "我的自訂路線";
    
    const creatorSpan = document.getElementById('route-creator-span');
    if(creatorSpan) {
        creatorSpan.textContent = '';
        creatorSpan.classList.add('hidden');
    }

    if (tempSearchMarker) { map.removeLayer(tempSearchMarker); tempSearchMarker = null; }
    currentRouteId = null;
    currentRouteOwner = null;
    window.history.replaceState({}, document.title, window.location.pathname);
    updateWaypointsUI();
}

// 僅清除運算出的軌跡線及圖表，保留航點
function clearTrack() {
    parsedTrackPoints = [];
    [gpxPolyline, startMarker, endMarker, syncMarker].forEach(m => m && map.removeLayer(m));
    if (elevationChart) { elevationChart.destroy(); elevationChart = null; }
    updateStatsUI(0, 0, 0, 0, 0, 0);

    checkLoginStatus(); 
}

// 切換路段數據的顯示與隱藏
function toggleSegmentStats() {
    isSegmentStatsVisible = !isSegmentStatsVisible;
    const textSpan = document.getElementById('toggle-segment-text');
    if(textSpan) textSpan.textContent = isSegmentStatsVisible ? "隱藏路段" : "顯示路段";
    updateWaypointsUI();
}

// 更新側邊欄的航點與路段列表 UI
function updateWaypointsUI() {
    const list = document.getElementById('waypoints-list');
    list.innerHTML = '';

    const canCalculate = waypoints.length >= 2;
    toggleActionBtn('calc-route-btn', canCalculate, canCalculate ? "點擊開始規劃路線" : "請至少加入兩個航點才能規劃路線");

    if(waypoints.length === 0) {
        list.innerHTML = '<div class="text-sm text-slate-400 text-center mt-4">搜尋或點選地圖加入航點</div>';
        checkLoginStatus();
        return;
    }

    waypoints.forEach((wp, idx) => {
        const wrapperLi = document.createElement('li');
        wrapperLi.className = 'waypoint-wrapper flex flex-col mb-2';
        const wpDiv = document.createElement('div');
        wpDiv.className = 'p-2.5 bg-white border border-slate-200 rounded-md flex justify-between items-center text-sm shadow-sm group';
        const dragHandleHtml = `<div class="drag-handle cursor-grab text-slate-400 hover:text-slate-700 p-1 flex items-center justify-center transition-colors rounded" title="按住拖曳排序"><svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16l5 5 5-5M7 8l5-5 5 5"/></svg></div>`;
        wpDiv.innerHTML = `<div class="flex items-center gap-2 overflow-hidden flex-1"><span class="w-6 h-6 rounded-full bg-slate-800 text-white flex items-center justify-center text-xs shrink-0 font-bold">${idx + 1}</span><span class="truncate font-medium text-slate-700 flex-1" title="${wp.name}">${wp.name}</span></div><div class="flex items-center shrink-0 gap-1 ml-2"><button onclick="editWaypointName(${idx})" class="text-slate-400 hover:text-blue-500 p-1 flex items-center justify-center transition-colors rounded" title="編輯名稱"><svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg></button>${dragHandleHtml}<button onclick="removeWaypoint(${idx})" class="text-slate-400 hover:text-rose-500 p-1 flex items-center justify-center transition-colors rounded" title="移除"><svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button></div>`;
        wrapperLi.appendChild(wpDiv);

        if (isSegmentStatsVisible && segmentsStats.length > idx && idx < waypoints.length - 1) {
            const seg = segmentsStats[idx];
            const segDiv = document.createElement('div');
            segDiv.className = 'flex flex-col gap-1 py-1.5 px-3 ml-6 mt-1 border-l-2 border-dashed border-slate-300 text-sm font-mono text-slate-500';
            segDiv.innerHTML = `<div class="flex items-center gap-3"><span class="text-emerald-600">－ ${seg.dist.toFixed(2)} km</span><span class="text-emerald-600">↗ ${Math.round(seg.gain)} m</span><span class="text-emerald-600">↘ ${Math.round(seg.loss)} m</span></div>`;
            wrapperLi.appendChild(segDiv);
        }
        list.appendChild(wrapperLi);
    });

    checkLoginStatus();
}

// 計算並記錄兩點之間的各路段距離及爬升下降
function calculateSegmentStats() {
    segmentsStats = []; if (waypoints.length < 2 || parsedTrackPoints.length === 0) return;
    let wpIndices = [], searchStartIndex = 0;
    for (let wp of waypoints) {
        let closestIdx = searchStartIndex, minDist = Infinity;
        for (let j = searchStartIndex; j < parsedTrackPoints.length; j++) {
            let d = calculateHaversineDistance(wp.lat, wp.lon, parsedTrackPoints[j].lat, parsedTrackPoints[j].lon);
            if (d < minDist) { minDist = d; closestIdx = j; }
        }
        wpIndices.push(closestIdx); searchStartIndex = closestIdx;
    }

    for (let k = 0; k < wpIndices.length - 1; k++) {
        let startIdx = wpIndices[k], endIdx = wpIndices[k+1], dist = parsedTrackPoints[endIdx].distCumulative - parsedTrackPoints[startIdx].distCumulative;
        let gain = 0, loss = 0, refEle = parsedTrackPoints[startIdx].ele;
        for(let j = startIdx + 1; j <= endIdx; j++) {
            let eleDiff = parsedTrackPoints[j].ele - refEle;
            if (Math.abs(eleDiff) >= 2.5) { eleDiff > 0 ? gain += eleDiff : loss += Math.abs(eleDiff); refEle = parsedTrackPoints[j].ele; }
        }
        segmentsStats.push({ dist, gain, loss });
    }
}

// 根據設定的航點呼叫 BRouter API 進行路線規劃
async function calculateRoute() {
    if (waypoints.length < 2) return;
    const btn = document.getElementById('calc-route-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> 規劃中...`;
    btn.disabled = true;

    try {
        const coordsStr = waypoints.map(w => `${w.lon},${w.lat}`).join('|');
        const brouterUrl = `https://brouter.de/brouter?lonlats=${coordsStr}&profile=trekking&format=gpx`;
        const response = await fetch(brouterUrl);
        if (!response.ok) throw new Error(`伺服器異常 (HTTP ${response.status})。請確認地點之間是否有可通行的道路。`);
        const gpxText = await response.text();
        if (!gpxText.includes('<gpx')) throw new Error(`路線引擎無法規劃此路徑: ${gpxText}`);

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(gpxText, "text/xml");
        if (xmlDoc.querySelector('parsererror')) throw new Error("路線引擎回傳的資料格式錯誤。");
        const trkpts = xmlDoc.getElementsByTagName('trkpt');
        if (trkpts.length === 0) throw new Error("路線引擎未能回傳有效的軌跡 (可能兩點距離太近或無路)。");

        let rawPoints = [];
        for (let i = 0; i < trkpts.length; i++) {
            const pt = trkpts[i];
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            let ele = 0;
            const eleNode = pt.getElementsByTagName('ele')[0];
            if (eleNode && eleNode.textContent) ele = parseFloat(eleNode.textContent);
            rawPoints.push({ lat, lon, ele });
        }

        processTrackData(rawPoints);
        calculateSegmentStats();

        updateWaypointsUI();
        if (gpxPolyline) map.fitBounds(gpxPolyline.getBounds(), { padding: [50, 50] });

    } catch (err) {
        alert("路線計算發生錯誤:\n" + err.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// 儲存當前路線資料至雲端
async function saveToCloud() {
    if (waypoints.length === 0) return alert("目前沒有地點可以儲存！");

    const token = localStorage.getItem('auth_token');
    const username = localStorage.getItem('auth_username');
    if (!token || !username) return alert("請先登入系統才能儲存路線！");

    if (currentRouteId && currentRouteOwner !== username) {
        return alert("您不是此路線的建立者，無法覆寫。請使用「建立副本」。");
    }

    const btn = document.getElementById('save-cloud-btn');
    const originalContent = btn.innerHTML;
    btn.innerHTML = `<svg class="animate-spin h-4 w-4 text-emerald-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> 儲存中...`;
    btn.disabled = true;

    try {
        const routeTitle = document.getElementById('route-title').value.trim() || "未命名路線";
        const payload = { routeName: routeTitle, waypoints: waypoints, username: username, token: token };
        if (currentRouteId) payload.id = currentRouteId;

        const response = await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
        const result = await response.json();

        if (result.status === 'success') {
            currentRouteId = result.id;
            currentRouteOwner = username; 
            isRouteModified = false; 
            const shareUrl = window.location.origin + window.location.pathname + '?id=' + currentRouteId;
            window.history.replaceState({}, document.title, shareUrl);
            
            const creatorSpan = document.getElementById('route-creator-span');
            if(creatorSpan) {
                creatorSpan.textContent = `建立者: ${username}`;
                creatorSpan.classList.remove('hidden');
            }

            updateWaypointsUI();
            alert('儲存成功！');
        }
        else throw new Error(result.message);
    } catch (error) {
        alert(`❌ 儲存失敗...\n錯誤訊息：${error.message}`);
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
}

// 準備將當前路線建立為雲端副本
function saveAsCopy() {
    if (waypoints.length === 0) return alert("目前沒有地點可以儲存！");

    const token = localStorage.getItem('auth_token');
    const username = localStorage.getItem('auth_username');
    if (!token || !username) return alert("請先登入系統才能儲存路線！");

    const currentTitle = document.getElementById('route-title').value.trim() || "未命名路線";
    document.getElementById('copy-route-title').value = currentTitle + " (副本)";
    
    document.getElementById('copy-modal').classList.remove('hidden');
}

// 關閉另存副本對話框
function closeCopyModal() {
    document.getElementById('copy-modal').classList.add('hidden');
}

// 確認將當前路線儲存為新的雲端副本
async function confirmSaveAsCopy(event) {
    event.preventDefault(); 

    const token = localStorage.getItem('auth_token');
    const username = localStorage.getItem('auth_username');
    const newRouteTitle = document.getElementById('copy-route-title').value.trim() || "未命名路線";

    const btn = document.getElementById('submit-copy-btn');
    const originalContent = btn.innerHTML;
    btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> 建立中...`;
    btn.disabled = true;

    try {
        const payload = { routeName: newRouteTitle, waypoints: waypoints, username: username, token: token };

        const response = await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
        const result = await response.json();

        if (result.status === 'success') {
            currentRouteId = result.id;
            currentRouteOwner = username;
            isRouteModified = false; 
            document.getElementById('route-title').value = newRouteTitle;
            const shareUrl = window.location.origin + window.location.pathname + '?id=' + currentRouteId;
            window.history.replaceState({}, document.title, shareUrl);

            const creatorSpan = document.getElementById('route-creator-span');
            if(creatorSpan) {
                creatorSpan.textContent = `建立者: ${username}`;
                creatorSpan.classList.remove('hidden');
            }

            updateWaypointsUI();
            closeCopyModal();
            alert('建立成功！之後修改請按「儲存雲端」按鈕');
        }
        else throw new Error(result.message);
    } catch (error) {
        alert(`❌ 建立失敗...\n錯誤訊息：${error.message}`);
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
}

// 產生並開啟分享網址的對話框
function openShareModalDirectly() {
    if (!currentRouteId) return alert('請先儲存路線才能進行分享！');
    const shareUrl = window.location.origin + window.location.pathname + '?id=' + currentRouteId;
    document.getElementById('share-link-input').value = shareUrl;
    document.getElementById('share-modal').classList.remove('hidden');
}

// 關閉分享網址對話框
function closeShareModal() {
    document.getElementById('share-modal').classList.add('hidden');
    document.getElementById('copy-link-btn').textContent = '複製';
}

// 複製分享網址至剪貼簿
function copyShareLink() {
    const input = document.getElementById('share-link-input');
    input.select(); input.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(input.value).then(() => {
        const btn = document.getElementById('copy-link-btn');
        btn.textContent = '複製';
    });
}

// 透過路由 ID 載入對應的雲端路線
async function loadRouteById(id) {
    const loader = document.getElementById('full-page-loader');
    loader.classList.remove('hidden');

    try {
        const response = await fetch(`${SCRIPT_URL}?action=getRoute&id=${id}`);
        const result = await response.json();

        if (result.status === 'success') {
            currentRouteId = result.route.id;
            await importRouteFromCloud(result.route.name, result.route.waypoints, result.route.id, result.route.owner);
        } else {
            alert("載入分享連結失敗：" + result.message);
            window.history.replaceState({}, document.title, window.location.pathname);
            currentRouteId = null;
            updateWaypointsUI();
        }
    } catch (error) {
        alert("網路或連線發生錯誤，無法載入路線。");
    } finally {
        loader.classList.add('hidden');
    }
}

// 開啟並讀取使用者的雲端路線清單
async function openCloudModal() {
    document.getElementById('cloud-modal').classList.remove('hidden');
    const list = document.getElementById('cloud-routes-list');
    list.innerHTML = '<li class="text-center text-sm text-slate-500 py-8"><svg class="animate-spin mx-auto h-6 w-6 text-green-500 mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>讀取雲端資料中...</li>';

    try {
        const response = await fetch(SCRIPT_URL);
        const result = await response.json();
        if (result.status === 'success') renderCloudRoutes(result.routes);
        else throw new Error(result.message);
    } catch (error) { list.innerHTML = `<li class="text-center text-sm text-rose-500 py-8">讀取失敗: ${error.message}</li>`; }
}

// 關閉雲端路線清單對話框
function closeCloudModal() { document.getElementById('cloud-modal').classList.add('hidden'); }

// 渲染顯示雲端紀錄清單
function renderCloudRoutes(routes) {
    const list = document.getElementById('cloud-routes-list');
    list.innerHTML = '';

    if (!routes || routes.length === 0) return list.innerHTML = '<li class="text-center text-sm text-slate-500 py-8">目前沒有雲端紀錄</li>';

    const currentUsername = localStorage.getItem('auth_username');

    routes.forEach(route => {
        const li = document.createElement('li');
        li.className = 'p-3 bg-white border border-slate-200 rounded-lg hover:border-green-300 hover:shadow-md transition cursor-pointer flex flex-col gap-2';

        const timeStr = isNaN(new Date(route.time)) ? route.time : new Date(route.time).toLocaleString();
        const ownerName = route.owner || '未知名稱';
        const icon = '<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /></svg>';
        const isOwner = (currentUsername === ownerName);
        const deleteBtnHtml = isOwner
            ? `<button class="delete-route-btn shrink-0 px-3 py-1.5 bg-rose-50 text-rose-700 border border-rose-200 rounded text-sm font-semibold hover:bg-rose-600 hover:text-white transition">刪除</button>`
            : `<button disabled class="shrink-0 px-3 py-1.5 bg-slate-50 text-slate-400 border border-slate-200 rounded text-sm font-semibold cursor-not-allowed opacity-60">刪除</button>`;

        li.innerHTML = `
            <div class="flex justify-between items-center w-full">
                <div class="flex flex-col flex-1 overflow-hidden pr-2">
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-slate-800 truncate">${route.name}</span>
                        <span class="inline-flex items-center gap-1 text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full border border-slate-200 whitespace-nowrap">${icon} <span>${ownerName}</span></span>
                    </div>
                    <span class="text-xs text-slate-400 mt-1">${timeStr}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <button class="select-route-btn px-3 py-1.5 bg-green-50 text-green-700 border border-green-200 rounded text-sm font-semibold hover:bg-green-600 hover:text-white transition">匯入</button>
                    ${deleteBtnHtml}
                </div>
            </div>
        `;

        li.querySelector('.select-route-btn').onclick = (e) => {
            e.stopPropagation();
            importRouteFromCloud(route.name, route.waypoints, route.id, route.owner);
        };
        li.onclick = () => importRouteFromCloud(route.name, route.waypoints, route.id, route.owner);

        const delBtn = li.querySelector('.delete-route-btn');
        if (delBtn) {
            delBtn.onclick = (e) => {
                e.stopPropagation();
                openDeleteModal(route.id, route.name);
            };
        }

        list.appendChild(li);
    });
}

// 顯示刪除確認對話框
function openDeleteModal(routeId, routeName) {
    routeToDeleteId = routeId;
    document.getElementById('delete-confirm-message').innerHTML = `確定要刪除 <span class="font-bold text-rose-600">「${routeName}」</span> ？此動作無法復原。`;
    document.getElementById('delete-confirm-modal').classList.remove('hidden');
}

// 隱藏刪除確認對話框
function closeDeleteModal() {
    document.getElementById('delete-confirm-modal').classList.add('hidden');
    routeToDeleteId = null;
}

// 執行刪除路線的操作
async function confirmDeleteRoute() {
    if (!routeToDeleteId) return;

    const btn = document.getElementById('confirm-delete-btn');
    const originalText = btn.innerHTML;
    
    btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> 刪除中...`;
    btn.disabled = true;

    await deleteCloudRoute(routeToDeleteId);

    btn.innerHTML = originalText;
    btn.disabled = false;
    closeDeleteModal();
}

// 呼叫雲端 API 刪除指定路線
async function deleteCloudRoute(routeId) {
    const token = localStorage.getItem('auth_token');
    const username = localStorage.getItem('auth_username');

    if (!token || !username) return alert("驗證資訊遺失，請重新登入");

    try {
        const payload = {
            action: 'delete',
            id: routeId,
            username: username,
            token: token
        };

        const response = await fetch(SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();

        if (result.status === 'success') {
            alert("刪除成功！");
            if (currentRouteId === routeId) {
               currentRouteId = null;
               window.history.replaceState({}, document.title, window.location.pathname);
            }
            openCloudModal();
        } else {
            throw new Error(result.message);
        }
    } catch (e) {
        alert("刪除失敗：" + e.message);
    }
}

// 將雲端讀取的資料套用並重新載入地圖上
async function importRouteFromCloud(name, waypointsStr, id, owner) {
    try {
        const loadedWaypoints = JSON.parse(waypointsStr);
        if (!loadedWaypoints || loadedWaypoints.length === 0) return alert("此紀錄無有效的路線點");

        closeCloudModal();
        clearRoute();

        if (id) {
            currentRouteId = id;
            currentRouteOwner = owner || null;
            window.history.replaceState({}, document.title, window.location.pathname + '?id=' + id);
        }

        document.getElementById('route-title').value = name;

        const creatorSpan = document.getElementById('route-creator-span');
        if (creatorSpan && owner) {
            creatorSpan.textContent = `建立者: ${owner}`;
            creatorSpan.classList.remove('hidden');
        }

        loadedWaypoints.forEach(wp => addWaypoint(wp.lat, wp.lon, wp.name));

        if (waypoints.length >= 2) {
            await calculateRoute();
        } else if (waypointMarkers.length > 0) {
            const group = new L.featureGroup(waypointMarkers);
            map.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 14 });
        }
        
        isRouteModified = false; 
        checkLoginStatus(); 
        
    } catch(e) { alert("匯入路線解析失敗！"); }
}

// 處理開啟本地 GPX 檔案並提取航點與軌跡
function handleOpenGPX(event) {
    const file = event.target.files[0]; 
    if (!file) return;
    
    clearRoute();
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const xmlDoc = new DOMParser().parseFromString(e.target.result, "text/xml");
            if (xmlDoc.querySelector('parsererror')) throw new Error("解析 GPX 錯誤。");
            
            const nameNode = xmlDoc.querySelector('trk > name') || xmlDoc.querySelector('metadata > name');
            document.getElementById('route-title').value = (nameNode && nameNode.textContent) ? nameNode.textContent.trim() : "匯入的路線";
            
            const wpts = xmlDoc.getElementsByTagName('wpt');
            for (let i = 0; i < wpts.length; i++) {
                const pt = wpts[i];
                const lat = parseFloat(pt.getAttribute('lat'));
                const lon = parseFloat(pt.getAttribute('lon'));
                if (isNaN(lat) || isNaN(lon)) continue; 
                
                const pNameNode = pt.querySelector('name');
                const name = pNameNode ? pNameNode.textContent.trim() : `航點 ${waypoints.length + 1}`;
                waypoints.push({ lat, lon, name });
            }
            
            let ptsNodes = xmlDoc.getElementsByTagName('trkpt');
            if (ptsNodes.length === 0) ptsNodes = xmlDoc.getElementsByTagName('rtept');
            
            let rawPoints = [];
            for (let i = 0; i < ptsNodes.length; i++) {
                const pt = ptsNodes[i];
                const lat = parseFloat(pt.getAttribute('lat'));
                const lon = parseFloat(pt.getAttribute('lon'));
                if (isNaN(lat) || isNaN(lon)) continue;
                
                let eleNode = pt.getElementsByTagName('ele')[0];
                let ele = eleNode ? parseFloat(eleNode.textContent) : 0;
                if (isNaN(ele)) ele = 0;
                rawPoints.push({ lat, lon, ele });
            }
            
            if (rawPoints.length === 0 && waypoints.length === 0) {
                throw new Error("找不到有效的航點或軌跡點。");
            }
            
            if (waypoints.length === 0 && rawPoints.length > 0) {
                const start = rawPoints[0];
                waypoints.push({ lat: start.lat, lon: start.lon, name: "起點" });
                if (rawPoints.length > 1) {
                    const end = rawPoints[rawPoints.length - 1];
                    waypoints.push({ lat: end.lat, lon: end.lon, name: "終點" });
                }
            }
            
            waypoints.forEach((wp, idx) => {
                const markerIcon = L.divIcon({ className: 'custom-div-icon', html: `<div style="background-color: #0f172a; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${idx + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
                const marker = L.marker([wp.lat, wp.lon], {icon: markerIcon}).addTo(map).bindTooltip(wp.name, {direction: 'top'});
                waypointMarkers.push(marker);
            });
            
            if (rawPoints.length > 0) {
                processTrackData(rawPoints);
                calculateSegmentStats(); 
            } else if (waypointMarkers.length > 0) {
                const group = new L.featureGroup(waypointMarkers);
                map.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 14 });
            }
            
            updateWaypointsUI();
            
            if (gpxPolyline && map.hasLayer(gpxPolyline)) {
                map.fitBounds(gpxPolyline.getBounds(), { padding: [50, 50] });
            }
            
            isRouteModified = true;
            checkLoginStatus();
            
        } catch (err) {
            alert(err.message);
        } finally {
            document.getElementById('open-gpx-input').value = '';
        }
    };
    reader.readAsText(file);
}

// 處理並平滑化匯入的軌跡資料以計算總距離與海拔起伏
function processTrackData(rawPoints) {
    if (!rawPoints || rawPoints.length === 0) return;
    const halfWin = 3;
    for (let i = 0; i < rawPoints.length; i++) {
        let sum = 0, count = 0;
        for (let j = Math.max(0, i - halfWin); j <= Math.min(rawPoints.length - 1, i + halfWin); j++) { sum += rawPoints[j].ele; count++; }
        rawPoints[i].smoothedEle = sum / count;
    }

    parsedTrackPoints = [];
    let totalDistance = 0, totalGain = 0, totalLoss = 0, maxEle = -Infinity, minEle = Infinity, refEle = rawPoints.length > 0 ? rawPoints[0].smoothedEle : 0;
    const elevationThreshold = 2.5;

    for (let i = 0; i < rawPoints.length; i++) {
        const pt = rawPoints[i], ele = pt.smoothedEle;
        if (i > 0) totalDistance += calculateHaversineDistance(parsedTrackPoints[i-1].lat, parsedTrackPoints[i-1].lon, pt.lat, pt.lon);
        let eleDiff = ele - refEle;
        if (Math.abs(eleDiff) >= elevationThreshold) { eleDiff > 0 ? totalGain += eleDiff : totalLoss += Math.abs(eleDiff); refEle = ele; }
        if (ele > maxEle) maxEle = ele; if (ele < minEle) minEle = ele;
        parsedTrackPoints.push({ lat: pt.lat, lon: pt.lon, ele: ele, distCumulative: totalDistance });
    }
    if (maxEle === -Infinity) maxEle = 0; if (minEle === Infinity) minEle = 0;
    updateStatsUI(totalDistance, totalGain, totalLoss, maxEle, minEle, parsedTrackPoints.length);
    drawMap(); drawChart();

    checkLoginStatus(); 
}

// 替換特殊字元以確保 XML 格式正確
function escapeXML(str) {
    if (!str) return "";
    return str.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;'; case '>': return '&gt;'; case '&': return '&amp;'; case '\'': return '&apos;'; case '"': return '&quot;';
        }
    });
}

// 將航點與軌跡資料打包並產生 GPX 字串
function generateGPXString() {
    const rawTitle = document.getElementById('route-title').value.trim() || "未命名路線";
    const routeTitle = escapeXML(rawTitle);

    let gpxStr = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpxStr += `<gpx version="1.1" creator="GPX Planner" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    gpxStr += `  <metadata>\n    <name>${routeTitle}</name>\n  </metadata>\n`;

    waypoints.forEach((wp) => {
        const safeName = escapeXML(wp.name);
        gpxStr += `  <wpt lat="${wp.lat}" lon="${wp.lon}">\n`;
        gpxStr += `    <name>${safeName}</name>\n`;
        gpxStr += `  </wpt>\n`;
    });

    gpxStr += `  <trk>\n    <name>${routeTitle}</name>\n    <trkseg>\n`;
    for (let pt of parsedTrackPoints) {
        gpxStr += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">\n`;
        gpxStr += `        <ele>${pt.ele.toFixed(2)}</ele>\n`;
        gpxStr += `      </trkpt>\n`;
    }
    gpxStr += `    </trkseg>\n  </trk>\n`;
    gpxStr += `</gpx>`;

    return { routeTitle: rawTitle, gpxStr };
}

// 下載目前產生的 GPX 檔案
function downloadGPX() {
    if (parsedTrackPoints.length === 0) return alert("目前沒有軌跡可下載！");
    const { routeTitle, gpxStr } = generateGPXString(), now = new Date();
    const fileName = `${routeTitle}_${now.toISOString().slice(0,10).replace(/-/g, '')}_${now.toTimeString().slice(0,8).replace(/:/g, '')}.gpx`;
    const blob = new Blob([gpxStr], { type: 'application/gpx+xml' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.style.display = 'none'; a.href = url; a.download = fileName; document.body.appendChild(a); a.click();
    window.URL.revokeObjectURL(url); document.body.removeChild(a);
}

// 透過半正矢公式 (Haversine) 計算兩個經緯度的直線距離
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 更新畫面上的總體路線數據 UI
function updateStatsUI(dist, gain, loss, maxE, minE, pts) {
    document.getElementById('stat-distance').textContent = dist.toFixed(2);
    document.getElementById('stat-gain').textContent = Math.round(gain); document.getElementById('stat-loss').textContent = Math.round(loss);
    document.getElementById('stat-max-ele').textContent = Math.round(maxE); document.getElementById('stat-min-ele').textContent = Math.round(minE);
    document.getElementById('stat-points').textContent = pts.toLocaleString();
}

// 在地圖上畫出最終計算好的軌跡與起終點
function drawMap() {
    [gpxPolyline, startMarker, endMarker, syncMarker].forEach(m => m && map.removeLayer(m));
    if(parsedTrackPoints.length === 0) return;
    const latlngs = parsedTrackPoints.map(pt => [pt.lat, pt.lon]);
    gpxPolyline = L.polyline(latlngs, { color: '#ef4444', weight: 4, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    if (waypoints.length === 0) {
        startMarker = L.circleMarker(latlngs[0], { radius: 6, fillColor: "#10b981", color: "#fff", weight: 2, opacity: 1, fillOpacity: 1 }).bindTooltip("起點").addTo(map);
        endMarker = L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, fillColor: "#f59e0b", color: "#fff", weight: 2, opacity: 1, fillOpacity: 1 }).bindTooltip("終點").addTo(map);
    }
}

// 繪製底部海拔高度圖表
function drawChart() {
    const ctx = document.getElementById('elevation-chart').getContext('2d');
    if (elevationChart) elevationChart.destroy();
    if (parsedTrackPoints.length === 0) return;
    Chart.defaults.font.family = "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif"; Chart.defaults.color = '#64748b';
    elevationChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: parsedTrackPoints.map(pt => pt.distCumulative.toFixed(2)),
            datasets: [{
                label: '海拔 (m)',
                data: parsedTrackPoints.map(pt => pt.ele),
                borderColor: '#22c55e', backgroundColor: 'rgba(34, 197, 94, 0.1)', borderWidth: 1.5, fill: true, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#16a34a', tension: 0.1
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15, 23, 42, 0.9)', callbacks: { title: ctx => [`距離: ${ctx[0].label} km`, `海拔: ${ctx[0].parsed.y.toFixed(1)} m`], label: ctx => null } } },
            scales: { x: { title: { display: true, text: '距離 (km)' }, ticks: { maxTicksLimit: 10 } }, y: { title: { display: true, text: '海拔 (m)' } } },
            onHover: (event, chartElement) => chartElement.length > 0 ? updateSyncMarker(chartElement[0].index) : hideSyncMarker()
        }
    });
}

// 根據圖表所指的位置，更新地圖上的藍色對應同步標記
function updateSyncMarker(index) {
    const pt = parsedTrackPoints[index]; if (!pt) return;
    if (!syncMarker) syncMarker = L.circleMarker([pt.lat, pt.lon], { radius: 6, fillColor: "#3b82f6", color: "#ffffff", weight: 2, opacity: 1, fillOpacity: 1, zIndexOffset: 1000 }).addTo(map);
    else { syncMarker.setLatLng([pt.lat, pt.lon]); if (!map.hasLayer(syncMarker)) map.addLayer(syncMarker); }
}

// 隱藏圖表同步標記
function hideSyncMarker() { if (syncMarker && map.hasLayer(syncMarker)) map.removeLayer(syncMarker); }

// 切換海拔高度圖表的收合與展開狀態
function toggleChart() { const c = document.getElementById('chart-container'), i = document.getElementById('chart-icon'); c.classList.toggle('hidden'); i.classList.toggle('rotate-180'); setTimeout(() => map && map.invalidateSize(), 300); }

// 檢查使用者登入狀態並更新相關權限與介面按鈕
function checkLoginStatus() {
    const token = localStorage.getItem('auth_token');
    const username = localStorage.getItem('auth_username');
    const loginBtnText = document.getElementById('login-btn-text');
    const loginBtn = document.getElementById('login-btn');

    const canEdit = !currentRouteId || (currentRouteOwner === username);
    const hasPlannedRoute = parsedTrackPoints.length > 0; 

    if (token && username) {
        loginBtnText.textContent = `${username} (登出)`;
        loginBtn.onclick = handleLogout;

        if (hasPlannedRoute) {
            if (canEdit) {
                toggleActionBtn('save-cloud-btn', true, "");
            } else {
                toggleActionBtn('save-cloud-btn', false, "您不是建立者，請點擊旁邊的「建立副本」");
            }
            if (currentRouteId) {
                toggleActionBtn('save-copy-btn', true, "");
            } else {
                toggleActionBtn('save-copy-btn', false, "請先儲存為雲端紀錄才能建立副本");
            }
        } else {
            toggleActionBtn('save-cloud-btn', false, "地圖上必須有規劃的路線才能儲存");
            toggleActionBtn('save-copy-btn', false, "地圖上必須有規劃的路線才能建立副本");
        }
    } else {
        loginBtnText.textContent = '登入';
        loginBtn.onclick = openLoginModal;

        toggleActionBtn('save-cloud-btn', false, "請先登入");
        toggleActionBtn('save-copy-btn', false, "請先登入");
    }

    const canShare = !!currentRouteId && hasPlannedRoute && !isRouteModified;
    let shareTitle = "";
    if (!currentRouteId) {
        shareTitle = "請先儲存路線";
    } else if (isRouteModified) {
        shareTitle = "路線已修改，請先儲存才能分享";
    } else if (!hasPlannedRoute) {
        shareTitle = "地圖上必須有規劃的路線";
    }
    toggleActionBtn('share-route-btn', canShare, shareTitle);
    
    toggleActionBtn('download-gpx-btn', hasPlannedRoute, hasPlannedRoute ? "" : "地圖上必須有規劃的路線");

    const unsavedIndicator = document.getElementById('unsaved-indicator-span');
    if (unsavedIndicator) {
        if (isRouteModified && waypoints.length > 0) {
            unsavedIndicator.classList.remove('hidden');
        } else {
            unsavedIndicator.classList.add('hidden');
        }
    }
}

// 開啟使用者登入對話框
function openLoginModal() { document.getElementById('login-modal').classList.remove('hidden'); }

// 關閉使用者登入對話框並清空表單
function closeLoginModal() { document.getElementById('login-modal').classList.add('hidden'); document.getElementById('login-form').reset(); }

// 處理送出登入資訊以進行驗證
async function handleLogin(event) {
    event.preventDefault();

    const usernameInput = document.getElementById('login-username').value.trim();
    const passwordInput = document.getElementById('login-password').value;
    const submitBtn = document.getElementById('submit-login-btn');
    const originalText = submitBtn.textContent;

    submitBtn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> 驗證中...`;
    submitBtn.disabled = true;

    try {
        const payload = { action: 'login', username: usernameInput, password: passwordInput };
        const response = await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
        const result = await response.json();

        if (result.status === 'success') {
            localStorage.setItem('auth_token', result.token);
            localStorage.setItem('auth_username', result.username);
            alert(`登入成功！歡迎 ${result.username}`);
            closeLoginModal();
            checkLoginStatus();
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        alert(`❌ 登入失敗：\n${error.message}`);
    } finally {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
}

// 處理使用者登出操作
function handleLogout() {
    if (confirm("確定要登出嗎？")) {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_username');
        checkLoginStatus();
    }
}

// 顯示簡易吐司訊息通知
function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.remove('hidden');

    setTimeout(() => {
        toast.classList.add('hidden');
    }, 2000);
}

// 顯示客製化 Tailwind 樣式吐司訊息通知
function showTailwindToast(message) {
  const toast = document.createElement('div');

  toast.className = `
    fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999]
    bg-gray-800 text-white px-6 py-3 rounded-lg shadow-xl
    transition-all duration-300 opacity-100
  `;

  toast.innerText = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('translate-y-0', 'opacity-100');
    toast.classList.add('translate-y-4', 'opacity-0');

    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

// 將全部航點的名稱轉為文字格式並複製至剪貼簿
function copyWaypointsText() {
    if (waypoints.length === 0) {
        alert("目前沒有航點可供複製！");
        return;
    }
    
    const routeText = waypoints.map(wp => wp.name).join(" -> ");
    
    navigator.clipboard.writeText(routeText).then(() => {
        const textSpan = document.getElementById('copy-waypoints-text');
        if (textSpan) {
            const originalText = textSpan.textContent;
            textSpan.textContent = "已複製";
            
            setTimeout(() => {
                textSpan.textContent = originalText;
            }, 2000);
        }
    }).catch(err => {
        alert("複製失敗，可能是瀏覽器不允許剪貼簿權限。");
    });
}

// 覆寫預設 alert 以提供更佳的 UI 體驗
window.alert = function(message) {
  showTailwindToast(message);
};

// 畫面載入完畢後自動執行系統初始化
window.onload = init;