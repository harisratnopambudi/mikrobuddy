document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide Icons
    lucide.createIcons();

    // DOM Elements
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('btn-send-message');
    const welcomeScreen = document.getElementById('welcome-screen');
    const chatMessages = document.getElementById('chat-messages');
    const subBanner = document.getElementById('subscription-banner');
    const chatHistoryList = document.getElementById('history-list');
    
    // Router Indicator & Actions
    const activeRouterIndicator = document.getElementById('active-router-indicator');
    const activeRouterNameEl = document.getElementById('active-router-name');
    const btnDisconnectRouter = document.getElementById('btn-disconnect-router');

    // Modals
    const modalAddRouter = document.getElementById('modal-add-router');
    const modalVoucher = document.getElementById('modal-voucher');
    const modalTelegram = document.getElementById('modal-telegram');
    const modalSettings = document.getElementById('modal-settings');
    const connectionLoader = document.getElementById('connection-loader');

    // Dropdown Mode Select
    const btnModeSelect = document.getElementById('btn-mode-select');
    const modeDropdownMenu = document.getElementById('mode-dropdown-menu');
    const modeText = document.getElementById('mode-text');
    const modeIcon = document.getElementById('mode-icon');

    // State Variables
    let currentMode = 'biasa'; // 'biasa', 'diagnosa', 'eksekusi'
    let isSubscribed = false; // Set to false by default. Authenticate via Google Sign-In to activate PRO.
    let connectedRouter = null; // Stores connected router object
    let chats = [];
    let currentChatId = null;

    // --- Helper Functions ---
    const WORKER_BASE_URL = 'https://mikro-buddy.harisratnopambudi.workers.dev';

    const getStoragePrefix = () => {
        const savedAuth = localStorage.getItem('auth_user');
        if (savedAuth) {
            try {
                const email = JSON.parse(savedAuth).email;
                if (email) return email.toLowerCase().trim();
            } catch (e) {}
        }
        return 'guest';
    };

    const getWorkerEndpoint = (path) => {
        const base = localStorage.getItem('nine_router_worker_url') || WORKER_BASE_URL;
        return base.replace(/\/$/, '') + path;
    };

    const saveChatsToStorage = () => {
        const prefix = getStoragePrefix();
        localStorage.setItem(`mikrotik_chats_${prefix}`, JSON.stringify(chats));
        renderHistory();
    };

    const saveRouterToStorage = () => {
        const prefix = getStoragePrefix();
        localStorage.setItem(`connected_router_${prefix}`, JSON.stringify(connectedRouter));
    };

    const loadUserData = () => {
        const prefix = getStoragePrefix();
        chats = JSON.parse(localStorage.getItem(`mikrotik_chats_${prefix}`) || '[]');
        connectedRouter = JSON.parse(localStorage.getItem(`connected_router_${prefix}`) || 'null');
        
        // Update connected router badge/indicator UI
        const activeRouterIndicator = document.getElementById('active-router-indicator');
        const activeRouterNameEl = document.getElementById('active-router-name');
        
        if (connectedRouter && activeRouterIndicator && activeRouterNameEl) {
            activeRouterIndicator.classList.remove('hidden');
            activeRouterNameEl.textContent = connectedRouter.name;
        } else if (activeRouterIndicator) {
            activeRouterIndicator.classList.add('hidden');
        }

        // Prefill or clear the router form fields
        const nameInput = document.getElementById('router-name');
        const ipInput = document.getElementById('router-ip');
        const portInput = document.getElementById('router-port');
        const userInput = document.getElementById('router-user');
        const passInput = document.getElementById('router-pass');
        
        if (connectedRouter) {
            if (nameInput) nameInput.value = connectedRouter.name || '';
            if (ipInput) ipInput.value = connectedRouter.ip || '';
            if (portInput) portInput.value = connectedRouter.port || '';
            if (userInput) userInput.value = connectedRouter.user || '';
            if (passInput) passInput.value = connectedRouter.pass || '';
        } else {
            if (nameInput) nameInput.value = '';
            if (ipInput) ipInput.value = '';
            if (portInput) portInput.value = '8728'; // default standard RouterOS API port
            if (userInput) userInput.value = '';
            if (passInput) passInput.value = '';
        }
        
        renderHistory();
    };

    const callRouterAPI = async (endpoint, method = 'GET', data = null) => {
        if (!connectedRouter) return null;
        const proxyUrl = getWorkerEndpoint('/api/proxy');
        let response;
        try {
            response = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    target: connectedRouter.port ? `${connectedRouter.ip}:${connectedRouter.port}` : connectedRouter.ip,
                    username: connectedRouter.user,
                    password: connectedRouter.pass,
                    endpoint: endpoint,
                    method: method,
                    data: data
                })
            });
        } catch (networkErr) {
            throw new Error('Network error: ' + (networkErr.message || String(networkErr)));
        }

        let body;
        try {
            body = await response.json();
        } catch (parseErr) {
            const text = await response.text().catch(() => '');
            throw new Error(`Non-JSON response (HTTP ${response.status}): ${text.substring(0, 200)}`);
        }

        if (!response.ok) {
            const msg = body.details ? `${body.error} (${body.details})` : (body.error || `HTTP ${response.status}`);
            throw new Error(msg);
        }

        return body;
    };

    const updateModeSelection = (mode) => {
        currentMode = mode;
        const modeItems = document.querySelectorAll('.dropdown-item');
        modeItems.forEach(item => {
            if (item.getAttribute('data-mode') === mode) {
                item.classList.add('active');
                modeText.textContent = item.querySelector('.item-title').textContent.split(' ')[0];
                const itemIcon = item.querySelector('i').getAttribute('data-lucide');
                modeIcon.setAttribute('data-lucide', itemIcon);
            } else {
                item.classList.remove('active');
            }
        });
        lucide.createIcons();
        modeDropdownMenu.classList.remove('show');
    };

    const showConnectionLoader = (title, desc, duration = 2000) => {
        return new Promise((resolve) => {
            document.getElementById('loader-title').textContent = title;
            document.getElementById('loader-desc').textContent = desc;
            connectionLoader.classList.remove('hidden');
            setTimeout(() => {
                connectionLoader.classList.add('hidden');
                resolve();
            }, duration);
        });
    };

    // --- Modal Control ---
    const openModal = (modal) => modal.classList.remove('hidden');
    const closeModal = (modal) => modal.classList.add('hidden');

    document.querySelectorAll('.close-modal-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal-backdrop');
            if (modal) closeModal(modal);
        });
    });

    // Close modals on clicking backdrop
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-backdrop')) {
            closeModal(e.target);
        }
    });

    // --- Route Event Listeners ---
    document.getElementById('btn-add-router-sidebar').addEventListener('click', () => openModal(modalAddRouter));
    document.getElementById('btn-telegram').addEventListener('click', () => openModal(modalTelegram));
    document.getElementById('btn-voucher').addEventListener('click', () => openModal(modalVoucher));
    document.getElementById('btn-settings').addEventListener('click', () => openModal(modalSettings));
    document.getElementById('btn-view-packages').addEventListener('click', () => openModal(modalVoucher));
    document.getElementById('btn-upgrade-header').addEventListener('click', () => openModal(modalVoucher));

    // Mode Selector Dropdown toggle
    btnModeSelect.addEventListener('click', (e) => {
        e.stopPropagation();
        modeDropdownMenu.classList.toggle('show');
    });

    document.addEventListener('click', () => {
        modeDropdownMenu.classList.remove('show');
    });

    modeDropdownMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.dropdown-item');
        if (item) {
            updateModeSelection(item.getAttribute('data-mode'));
        }
    });

    // --- Form Submissions ---

    // Add Router Form
    document.getElementById('add-router-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        closeModal(modalAddRouter);

        const routerName = document.getElementById('router-name').value;
        const routerIp = document.getElementById('router-ip').value;
        const routerPort = document.getElementById('router-port').value;
        const routerUser = document.getElementById('router-user').value;
        const routerPass = document.getElementById('router-pass').value;

        await showConnectionLoader(
            'Menghubungkan ke Router...',
            `Mencoba koneksi REST/API ke ${routerIp}...`
        );

        connectedRouter = { 
            name: routerName, 
            ip: routerIp, 
            port: routerPort,
            user: routerUser,
            pass: routerPass
        };
        
        // Show indicator
        activeRouterNameEl.textContent = routerName;
        activeRouterIndicator.classList.remove('hidden');

        try {
            // Test connection using system resource
            const resource = await callRouterAPI('/system/resource');
            // RouterOS API returns an array of objects - get the first element
            const res = Array.isArray(resource) ? resource[0] : resource;
            if (res && (res['board-name'] || res.board || res.version)) {
                const boardName = res['board-name'] || res.board || 'MikroTik';
                const version = res.version || '';
                appendSystemNotification(`✅ Berhasil terhubung ke router: ${routerName} (${boardName} v${version})`);
            } else {
                appendSystemNotification(`✅ Berhasil terhubung ke router: ${routerName} (${routerIp})`);
            }
        } catch (err) {
            const errMsg = (err && err.message) ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
            console.error('Real API failed, fallback to simulation:', err);
            appendSystemNotification(`⚠️ Gagal koneksi real-time: ${errMsg}. Router: ${routerName} (${routerIp}) [Mode Simulasi/Offline]`);
        }

        saveRouterToStorage();

        // Automatically switch to Diagnostic mode
        updateModeSelection('diagnosa');
    });

    // Disconnect Router
    btnDisconnectRouter.addEventListener('click', async () => {
        await showConnectionLoader(
            'Memutus Koneksi...',
            `Menutup API session ke ${connectedRouter.name}...`,
            1000
        );
        appendSystemNotification(`Koneksi ke router ${connectedRouter.name} telah diputus.`);
        connectedRouter = null;
        saveRouterToStorage();
        activeRouterIndicator.classList.add('hidden');
        updateModeSelection('biasa');
    });



    // Telegram Settings Form
    document.getElementById('telegram-form').addEventListener('submit', (e) => {
        e.preventDefault();
        closeModal(modalTelegram);
        const chatId = document.getElementById('telegram-chat-id').value;
        appendSystemNotification(`Integrasi Telegram disimpan. ID: ${chatId}. Notifikasi uji coba telah dikirim ke perangkat Anda.`);
    });

    // On load, retrieve API key and worker URL from localStorage and prefill settings modal
    const apiKeyInput = document.getElementById('settings-api-key');
    const workerUrlInput = document.getElementById('settings-worker-url');
    if (apiKeyInput) {
        const storedKey = localStorage.getItem('nine_router_api_key');
        if (!storedKey || storedKey === 'sk-a1a2d2c6affdb6fd-myptku-553ed3c4' || storedKey.startsWith('AQ.')) {
            localStorage.setItem('nine_router_api_key', '');
        }
        apiKeyInput.value = localStorage.getItem('nine_router_api_key');
    }
    if (workerUrlInput) {
        if (!localStorage.getItem('nine_router_worker_url')) {
            localStorage.setItem('nine_router_worker_url', 'https://mikro-buddy.harisratnopambudi.workers.dev');
        }
        workerUrlInput.value = localStorage.getItem('nine_router_worker_url');
    }

    // Settings Form
    document.getElementById('btn-save-settings').addEventListener('click', () => {
        if (apiKeyInput) {
            localStorage.setItem('nine_router_api_key', apiKeyInput.value);
        }
        if (workerUrlInput) {
            localStorage.setItem('nine_router_worker_url', workerUrlInput.value);
        }
        closeModal(modalSettings);
        appendSystemNotification('Pengaturan berhasil disimpan.');
    });

    // Suggestion Cards trigger chat
    document.querySelectorAll('.suggestion-card').forEach(card => {
        card.addEventListener('click', () => {
            const query = card.getAttribute('data-query');
            submitQuery(query);
        });
    });

    // Obrolan Baru (New Chat) trigger
    document.getElementById('btn-new-chat').addEventListener('click', () => {
        resetChatWindow();
    });

    // Keyboard Shortcuts (Ctrl+K for New Chat)
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            resetChatWindow();
        }
    });

    // --- Message handling ---
    const appendMessage = (sender, content) => {
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${sender}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = sender === 'user' ? 'H' : 'M';

        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        contentEl.innerHTML = content;

        // Add interactive execution button to MikroTik script code blocks
        if (sender === 'assistant') {
            const codeBlocks = contentEl.querySelectorAll('pre');
            codeBlocks.forEach(pre => {
                const code = pre.querySelector('code');
                const codeText = code ? code.textContent.trim() : '';
                
                // Detect if it looks like RouterOS commands (starts with slash or has common commands)
                const isRouterOS = codeText.startsWith('/') || codeText.includes('/ip') || codeText.includes('/interface') || codeText.includes('/queue') || codeText.includes('/system');
                
                if (isRouterOS) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'code-block-wrapper';
                    
                    const header = document.createElement('div');
                    header.className = 'code-block-header';
                    
                    const lang = document.createElement('span');
                    lang.className = 'code-lang';
                    lang.textContent = 'RouterOS Script';
                    
                    const runBtn = document.createElement('button');
                    runBtn.className = 'btn-run-script';
                    runBtn.innerHTML = '<i data-lucide="play" style="width:12px; height:12px;"></i> Jalankan';
                    
                    // Action when script execution is requested
                    runBtn.addEventListener('click', async () => {
                        if (!connectedRouter) {
                            alert('Mohon hubungkan router MikroTik terlebih dahulu!');
                            return;
                        }
                        if (runBtn.classList.contains('running') || runBtn.classList.contains('success')) return;

                        runBtn.classList.add('running');
                        runBtn.innerHTML = '<i class="spinner-small"></i> Menjalankan...';

                        try {
                            const res = await fetch(getWorkerEndpoint('/api/run-script'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    target: connectedRouter.port ? `${connectedRouter.ip}:${connectedRouter.port}` : connectedRouter.ip,
                                    username: connectedRouter.user,
                                    password: connectedRouter.pass,
                                    script: codeText
                                })
                            });
                            
                            const data = await res.json();
                            if (res.ok && data.success) {
                                // Check if any individual line failed
                                const failedLine = (data.results || []).find(r => !r.success);
                                if (failedLine) {
                                    throw new Error(`Baris "${failedLine.line}" gagal: ${failedLine.error}`);
                                }
                                
                                runBtn.className = 'btn-run-script success';
                                runBtn.innerHTML = '<i data-lucide="check-circle" style="width:12px; height:12px;"></i> Berhasil!';
                                appendSystemNotification(`✅ Script berhasil dijalankan ke router ${connectedRouter.name}.`);
                            } else {
                                throw new Error(data.error || 'Eksekusi gagal');
                            }
                        } catch (err) {
                            runBtn.className = 'btn-run-script failed';
                            runBtn.innerHTML = '<i data-lucide="x-circle" style="width:12px; height:12px;"></i> Gagal';
                            alert(`Gagal menjalankan script: ${err.message}`);
                        }
                        lucide.createIcons();
                    });
                    
                    header.appendChild(lang);
                    header.appendChild(runBtn);
                    
                    // Re-structure DOM
                    pre.parentNode.insertBefore(wrapper, pre);
                    wrapper.appendChild(header);
                    wrapper.appendChild(pre);
                }
            });
        }

        bubble.appendChild(avatar);
        bubble.appendChild(contentEl);
        chatMessages.appendChild(bubble);

        // Scroll to bottom
        const chatViewport = document.querySelector('.chat-viewport');
        if (chatViewport) {
            chatViewport.scrollTop = chatViewport.scrollHeight;
        }
        
        lucide.createIcons();
        return bubble;
    };

    const typeWriter = (element, htmlText, speed = 8, callback = null) => {
        let i = 0;
        element.innerHTML = '';
        
        function step() {
            if (i < htmlText.length) {
                if (htmlText[i] === '<') {
                    const tagEnd = htmlText.indexOf('>', i);
                    if (tagEnd !== -1) {
                        element.innerHTML += htmlText.slice(i, tagEnd + 1);
                        i = tagEnd + 1;
                    } else {
                        element.innerHTML += htmlText[i];
                        i++;
                    }
                } else {
                    element.innerHTML += htmlText[i];
                    i++;
                }
                
                const chatViewport = document.querySelector('.chat-viewport');
                if (chatViewport) {
                    chatViewport.scrollTop = chatViewport.scrollHeight;
                }
                
                setTimeout(step, speed);
            } else {
                if (callback) callback();
            }
        }
        step();
    };

    const appendSystemNotification = (text) => {
        if (welcomeScreen.classList.contains('hidden')) {
            const sysMsg = `<p style="color:var(--success); font-weight:600;"><i data-lucide="info" style="display:inline-block; width:14px; height:14px; margin-right:6px; vertical-align:middle;"></i>${text}</p>`;
            appendMessage('assistant', sysMsg);
            lucide.createIcons();
        }
    };

    const resetChatWindow = () => {
        welcomeScreen.classList.remove('hidden');
        chatMessages.classList.add('hidden');
        chatMessages.innerHTML = '';
        currentChatId = null;
    };

    // Chat history search
    document.getElementById('chat-search').addEventListener('input', (e) => {
        renderHistory(e.target.value);
    });

    const renderHistory = (filter = '') => {
        chatHistoryList.innerHTML = '';
        const filtered = chats.filter(c => c.title.toLowerCase().includes(filter.toLowerCase()));

        if (filtered.length === 0) {
            chatHistoryList.innerHTML = '<div class="empty-history">Belum ada obrolan</div>';
            return;
        }

        filtered.forEach(chat => {
            const item = document.createElement('div');
            item.className = `history-item ${chat.id === currentChatId ? 'active' : ''}`;
            item.setAttribute('data-id', chat.id);
            
            const titleSpan = document.createElement('span');
            titleSpan.className = 'chat-title-text';
            titleSpan.textContent = chat.title;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-history-btn';
            deleteBtn.innerHTML = '<i data-lucide="trash-2" style="width:14px; height:14px;"></i>';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                chats = chats.filter(c => c.id !== chat.id);
                if (currentChatId === chat.id) resetChatWindow();
                saveChatsToStorage();
            });

            item.appendChild(titleSpan);
            item.appendChild(deleteBtn);

            item.addEventListener('click', () => loadChat(chat.id));
            chatHistoryList.appendChild(item);
        });
        lucide.createIcons();
    };

    const loadChat = (chatId) => {
        const chat = chats.find(c => c.id === chatId);
        if (!chat) return;

        currentChatId = chatId;
        welcomeScreen.classList.add('hidden');
        chatMessages.classList.remove('hidden');
        chatMessages.innerHTML = '';
        
        chat.messages.forEach(msg => {
            appendMessage(msg.sender, msg.content);
        });
        renderHistory();
    };

    // --- Submit Query ---
    const submitQuery = async (queryText) => {
        if (!queryText.trim()) return;

        // Check subscription logic for ordinary users
        if (!isSubscribed && chats.length >= 2 && !currentChatId) {
            openModal(modalVoucher);
            alert('Silakan aktifkan voucher / berlangganan paket Pro untuk melanjutkan obrolan baru.');
            return;
        }

        // Show chat interface
        welcomeScreen.classList.add('hidden');
        chatMessages.classList.remove('hidden');

        // Add user bubble
        appendMessage('user', `<p>${escapeHTML(queryText)}</p>`);

        // Update chats state
        if (!currentChatId) {
            currentChatId = Date.now().toString();
            chats.unshift({
                id: currentChatId,
                title: queryText.substring(0, 24) + (queryText.length > 24 ? '...' : ''),
                messages: []
            });
        }

        const activeChat = chats.find(c => c.id === currentChatId);
        activeChat.messages.push({ sender: 'user', content: `<p>${escapeHTML(queryText)}</p>` });

        // Clear input
        chatInput.value = '';

        // Generate response based on currentMode and connectedRouter
        const thinkingBubbleHtml = `
            <div class="thinking-bubble">
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
            </div>
        `;
        const thinkingBubble = appendMessage('assistant', thinkingBubbleHtml);

        const responseText = await simulateAIResponse(queryText, currentMode, connectedRouter);
        
        if (thinkingBubble) {
            thinkingBubble.remove();
        }

        const assistantBubble = appendMessage('assistant', '');
        const contentContainer = assistantBubble.querySelector('.message-content');

        // Check if there's a blockquote header (router info)
        const hasBlockquote = responseText.includes('<blockquote>');
        
        if (hasBlockquote) {
            // Render instantly to prevent typewriter layout formatting differences
            contentContainer.innerHTML = responseText;
            activeChat.messages.push({ sender: 'assistant', content: responseText });
            saveChatsToStorage();
        } else {
            typeWriter(contentContainer, responseText, 8, () => {
                activeChat.messages.push({ sender: 'assistant', content: responseText });
                saveChatsToStorage();
            });
        }
    };

    // Listeners for manual message inputs
    sendBtn.addEventListener('click', () => submitQuery(chatInput.value));
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') submitQuery(chatInput.value);
    });

    const escapeHTML = (text) => {
        return text.replace(/[&<>'"]/g, 
            tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
        );
    };

    // --- AI Simulation Engine (Now connected to real 9router AI API) ---
    const simulateAIResponse = async (query, mode, router) => {
        const lowerQuery = query.toLowerCase();

        // 1. Checks if router is connected for Modes that require connection
        if ((mode === 'diagnosa' || mode === 'eksekusi') && !router) {
            const warningTitle = mode === 'diagnosa' ? 'Peringatan Diagnosa' : 'Aksi Ditolak';
            const warningDesc = mode === 'diagnosa' 
                ? 'Mode Diagnosa memerlukan router terhubung untuk memindai status jaringan.' 
                : 'Mode Eksekusi memerlukan router aktif agar AI dapat menerapkan script konfigurasi.';
            return `
                <p><strong style="color:var(--danger)">${warningTitle}:</strong> Tidak ada router yang terhubung.</p>
                <p>${warningDesc}</p>
                <p>Mohon hubungkan router MikroTik terlebih dahulu menggunakan menu <strong>"Tambah Router"</strong> di sidebar.</p>
            `;
        }

        // 2. Fetch Router Context (if router is connected)
        let routerContext = '';
        let cachedResource = null;
        if (router) {
            try {
                // Fetch general resource info
                const resourceRaw = await callRouterAPI('/system/resource');
                const resource = Array.isArray(resourceRaw) ? resourceRaw[0] : resourceRaw;
                cachedResource = resource;
                if (resource) {
                    routerContext += `Connected Router Info:\n`;
                    routerContext += `- Name: ${router.name}\n`;
                    routerContext += `- Board Model: ${resource['board-name'] || resource.board || 'MikroTik'}\n`;
                    routerContext += `- RouterOS Version: ${resource.version || 'unknown'}\n`;
                    routerContext += `- CPU Load: ${resource['cpu-load'] || '0'}%\n`;
                    const freeMem = resource['free-memory'] ? (parseInt(resource['free-memory']) / 1024 / 1024).toFixed(1) : '?';
                    routerContext += `- Free Memory: ${freeMem} MB\n`;
                    routerContext += `- Uptime: ${resource.uptime || ''}\n\n`;
                }

                // Fetch active hotspot users & profiles if related to user/profile queries
                if (lowerQuery.includes('user') || lowerQuery.includes('aktif') || lowerQuery.includes('online') || lowerQuery.includes('pelanggan') || lowerQuery.includes('profil') || lowerQuery.includes('profile')) {
                    try {
                        const activeUsers = await callRouterAPI('/ip/hotspot/active');
                        if (Array.isArray(activeUsers)) {
                            routerContext += `Live Active Hotspot Users:\n${JSON.stringify(activeUsers, null, 2)}\n\n`;
                        }
                    } catch (e) {}
                    try {
                        const leases = await callRouterAPI('/ip/dhcp-server/lease');
                        if (Array.isArray(leases)) {
                            routerContext += `Live DHCP Leases:\n${JSON.stringify(leases.filter(l => l.status === 'bound'), null, 2)}\n\n`;
                        }
                    } catch (e) {}
                    try {
                        const profiles = await callRouterAPI('/ip/hotspot/user/profile');
                        if (Array.isArray(profiles)) {
                            routerContext += `Live Hotspot User Profiles Available:\n${JSON.stringify(profiles.map(p => ({
                                name: p.name,
                                'shared-users': p['shared-users'],
                                'rate-limit': p['rate-limit'] || 'unlimited'
                            })), null, 2)}\n\n`;
                        }
                    } catch (e) {}
                    try {
                        const users = await callRouterAPI('/ip/hotspot/user');
                        if (Array.isArray(users)) {
                            routerContext += `Live Hotspot Users List:\n${JSON.stringify(users.map(u => ({
                                name: u.name,
                                profile: u.profile,
                                comment: u.comment || ''
                            })), null, 2)}\n\n`;
                        }
                    } catch (e) {}
                }

                // Fetch Interfaces for network status queries
                if (lowerQuery.includes('interface') || lowerQuery.includes('trafik') || lowerQuery.includes('speed') || lowerQuery.includes('lambat')) {
                    const interfaces = await callRouterAPI('/interface');
                    if (Array.isArray(interfaces)) {
                        routerContext += `Live Router Interfaces Status:\n${JSON.stringify(interfaces.map(i => ({
                            name: i.name,
                            type: i.type,
                            running: i.running,
                            disabled: i.disabled
                        })), null, 2)}\n\n`;
                    }
                }
            } catch (err) {
                const errDetail = (err && err.message) ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
                routerContext += `Router is connected but failed to fetch live details: ${errDetail}\n\n`;
            }
        }

        // 3. Prepare AI Prompt
        const selectedModelEl = document.getElementById('settings-model');
        const selectedModel = selectedModelEl ? selectedModelEl.value : 'gemini-flash';
        
        // Map UI models to 9router API model names
        const modelMap = {
            'gemini-flash': 'gemini-1.5-flash',
            'gemini-pro': 'gemini-1.5-pro',
            'llama-large': 'llama-3-70b'
        };
        const modelName = modelMap[selectedModel] || 'gemini-1.5-flash';

        const systemPrompt = `Kamu adalah "MikroBuddy AI", asisten pakar MikroTik RouterOS. Bahasa: Indonesia.
Mode: "${mode.toUpperCase()}" (BIASA=konsultasi, DIAGNOSA=analisis data router, EKSEKUSI=buat script).

${routerContext ? `DATA REAL-TIME ROUTER:\n${routerContext}` : 'Tidak ada router terhubung.'}

ATURAN:
1. SINGKAT & TO THE POINT. Jangan bertele-tele. Langsung jawab inti pertanyaan. Maks 3-5 paragraf.
2. Format: Markdown biasa. Gunakan **bold**, \`code\`, tabel, list, dan code block (\`\`\`routeros).
3. Jangan ulangi data router yang sudah ditampilkan di dashboard. Langsung analisis/rekomendasi.
4. Jika mode DIAGNOSA: analisis singkat + rekomendasi konkret.
5. Jika mode EKSEKUSI: langsung berikan script, penjelasan minimal.`;

        // Build router info summary as a clean text block instead of a card grid
        const buildRouterCard = (routerObj, resourceData) => {
            if (!routerObj || !resourceData) return '';
            const res = Array.isArray(resourceData) ? resourceData[0] : resourceData;
            if (!res) return '';

            const boardName = res['board-name'] || res.board || 'MikroTik';
            const version = res.version || '-';
            const cpuLoad = parseInt(res['cpu-load'] || '0');
            const freeMem = res['free-memory'] ? (parseInt(res['free-memory']) / 1024 / 1024).toFixed(0) : '?';
            const uptime = res.uptime || '-';
            const arch = res['architecture-name'] || res.architecture || '';

            return `
<blockquote>
<strong>🖧 ${routerObj.name} (Online)</strong><br>
Model: <code>${boardName}</code> (${arch}) · RouterOS: <code>v${version}</code> · CPU: <code>${cpuLoad}%</code> · RAM Free: <code>${freeMem} MB</code> · Uptime: <code>${uptime}</code>
</blockquote>`;
        };

        // 4. Query the official Gemini API directly
        try {
            const activeChat = chats.find(c => c.id === currentChatId);
            
            // Construct message history in Gemini structure
            const apiMessages = [];

            // Add last 6 messages of conversation history
            if (activeChat && activeChat.messages) {
                const history = activeChat.messages.slice(-6);
                history.forEach(m => {
                    const plainContent = m.content.replace(/<[^>]*>/g, '');
                    apiMessages.push({
                        role: m.sender === 'user' ? 'user' : 'model',
                        parts: [{ text: plainContent }]
                    });
                });
            } else {
                apiMessages.push({
                    role: 'user',
                    parts: [{ text: query }]
                });
            }

            const apiKeyVal = localStorage.getItem('nine_router_api_key') || '';
            const workerUrl = localStorage.getItem('nine_router_worker_url') || 'https://mikro-buddy.harisratnopambudi.workers.dev';
            const modelsToTry = [modelName, 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest', 'gemini-2.5-flash'];
            const uniqueModels = [...new Set(modelsToTry)];
            let lastError = null;
            let response = null;

            for (const model of uniqueModels) {
                try {
                    const fetchUrl = workerUrl 
                        ? workerUrl 
                        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKeyVal}`;
                    
                    const fetchBody = {
                        contents: apiMessages,
                        systemInstruction: {
                            parts: [{ text: systemPrompt }]
                        }
                    };

                    if (workerUrl) {
                        fetchBody.model = model;
                    }

                    response = await fetch(fetchUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(fetchBody)
                    });
                    if (response.ok) {
                        break;
                    } else {
                        const errJson = await response.json();
                        const errMsg = (errJson.error && errJson.error.message) || errJson.error || 'Server returned error status';
                        lastError = new Error(errMsg);
                    }
                } catch (e) {
                    lastError = e;
                }
            }

            if (!response || !response.ok) {
                throw lastError || new Error('Gagal menghubungi Gemini API');
            }

            const resData = await response.json();
            if (resData.candidates && resData.candidates[0] && resData.candidates[0].content && resData.candidates[0].content.parts[0]) {
                let text = resData.candidates[0].content.parts[0].text;
                let htmlContent = '';
                
                if (typeof marked !== 'undefined') {
                    htmlContent = marked.parse(text);
                } else {
                    htmlContent = `<p>${text.replace(/\n/g, '<br>')}</p>`;
                }

                // Prepend router info card for status/connection queries
                const isStatusQuery = lowerQuery.match(/konek|status|sudah|connect|terhubung|info|router|resource|detail/i);
                if (router && cachedResource && isStatusQuery) {
                    htmlContent = buildRouterCard(router, cachedResource) + htmlContent;
                }

                return htmlContent;
            }
            throw new Error('Respon dari AI kosong atau tidak valid.');

        } catch (err) {
            console.error('Gemini API Error:', err);
            return `
                <p><strong style="color:var(--danger)">Kesalahan Koneksi AI:</strong> Gagal mendapatkan respon langsung dari Gemini API.</p>
                <p>Detail Error: <code>${err.message}</code></p>
                <p>Silakan periksa koneksi internet Anda atau coba lagi nanti.</p>
            `;
        }
    };

    // Responsive Sidebar Toggler
    const sidebarEl = document.querySelector('.sidebar');
    const toggleSidebarBtn = document.getElementById('btn-toggle-sidebar');
    const closeSidebarBtn = document.getElementById('btn-close-sidebar');

    if (toggleSidebarBtn && sidebarEl) {
        toggleSidebarBtn.addEventListener('click', () => {
            sidebarEl.classList.add('active');
        });
    }

    if (closeSidebarBtn && sidebarEl) {
        closeSidebarBtn.addEventListener('click', () => {
            sidebarEl.classList.remove('active');
        });
    }

    // Close sidebar on mobile when navigating or starting new chat
    document.querySelectorAll('.sidebar-nav button, .history-item').forEach(el => {
        el.addEventListener('click', () => {
            if (window.innerWidth <= 768 && sidebarEl) {
                sidebarEl.classList.remove('active');
            }
        });
    });




    // Google Sign-In Integration for Gmail Login
    window.handleCredentialResponse = async (response) => {
        try {
            const res = await fetch(getWorkerEndpoint('/api/auth/google'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ credential: response.credential })
            });
            if (res.ok) {
                const authData = await res.json();
                console.log('Google Auth Success:', authData);
                updateUserProfile(authData);
            }
        } catch (err) {
            console.error('Google Sign-In Error:', err);
        }
    };

    const updateUserProfile = (authData) => {
        const placeholder = document.getElementById('user-avatar-placeholder');
        const img = document.getElementById('user-avatar-img');
        const nameEl = document.getElementById('user-profile-name');
        const emailEl = document.getElementById('user-profile-email');
        const googleLoginContainer = document.getElementById('google-login-container');

        if (authData.picture) {
            img.src = authData.picture;
            img.classList.remove('hidden');
            placeholder.classList.add('hidden');
        } else {
            placeholder.textContent = authData.name ? authData.name.charAt(0).toUpperCase() : '?';
            placeholder.classList.remove('hidden');
            img.classList.add('hidden');
        }

        nameEl.textContent = authData.name || authData.email;
        emailEl.textContent = authData.isSubscribed ? `${authData.email} (PRO)` : authData.email;

        // Save auth state to localStorage
        localStorage.setItem('auth_user', JSON.stringify(authData));

        if (authData.isSubscribed) {
            isSubscribed = true;
            subBanner.classList.add('hidden');
            document.getElementById('btn-upgrade-header').textContent = 'Pro Aktif';
            document.getElementById('btn-upgrade-header').style.background = 'linear-gradient(135deg, var(--success) 0%, #059669 100%)';
            if (googleLoginContainer) googleLoginContainer.style.display = 'none';
        } else {
            isSubscribed = false;
            subBanner.classList.remove('hidden');
            document.getElementById('btn-upgrade-header').textContent = 'Upgrade ke Pro';
            document.getElementById('btn-upgrade-header').style.background = '';
            if (googleLoginContainer) googleLoginContainer.style.display = 'flex';
        }
        
        loadUserData();
    };

    const initGoogleLogin = () => {
        if (typeof google !== 'undefined') {
            google.accounts.id.initialize({
                client_id: '635273386003-ovajvn6p2kcrc41cdar9ste0i7tpch6u.apps.googleusercontent.com', // User Client ID
                callback: handleCredentialResponse
            });
            google.accounts.id.renderButton(
                document.getElementById('google-login-container'),
                { theme: 'outline', size: 'medium', width: '220', text: 'signin_with' }
            );
        } else {
            setTimeout(initGoogleLogin, 1000);
        }
    };

    const checkPersistedAuth = () => {
        const savedAuth = localStorage.getItem('auth_user');
        if (savedAuth) {
            try {
                const authData = JSON.parse(savedAuth);
                updateUserProfile(authData);
                
                // Live check subscription status on load via Cloudflare Worker
                fetch(getWorkerEndpoint(`/api/auth/check-subscription?email=${encodeURIComponent(authData.email)}`))
                    .then(r => r.json())
                    .then(checkData => {
                        authData.isSubscribed = checkData.isSubscribed;
                        updateUserProfile(authData);
                    })
                    .catch(e => console.warn('Failed to verify subscription status:', e));
            } catch (err) {
                console.error('Error parsing persisted auth state:', err);
                initGoogleLogin();
            }
        } else {
            initGoogleLogin();
        }
    };

    // Initial render and Auth Check
    loadUserData();
    checkPersistedAuth();
});
