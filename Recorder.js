// ==UserScript==
// @name            Starblast Game Recorder
// @name:ru         Starblast Game Recorder
// @namespace       https://greasyfork.org/ru/users/1252274-julia1233
// @version         1.8.4
// @description     Recording + replay via WebSocket simulation with user data protection
// @description:ru  Запись и воспроизведение сессий Starblast.io с защитой данных пользователя
// @author          Julia1233
// @license         GPL-3.0-or-later; https://www.gnu.org/licenses/gpl-3.0.txt
// @homepage        https://greasyfork.org/ru/scripts/554572-starblast-game-recorder/
// @supportURL      https://greasyfork.org/ru/scripts/554572-starblast-game-recorder/feedback
// @match           https://starblast.io/*
// @grant           none
// @icon            https://starblast.io/static/img/icon64.png
// @run-at          document-start
// ==/UserScript==

/*
 * Starblast Game Recorder v1.8.4
 * Copyright (c) 2025 Julia1233
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

(function () {
    'use strict';

    window.__allWebSockets = [];
    window.__recorderInstance = null;
    window.__playingRecording = null;
    window.__wsListeners = [];
    window.__fakeServerMode = false;
    window.__hideOverlay = false;

    const OriginalWebSocket = window.WebSocket;
    const OriginalSend = OriginalWebSocket.prototype.send;
    const OriginalAddEventListener = OriginalWebSocket.prototype.addEventListener;

    OriginalWebSocket.prototype.send = function (data) {
        const recorder = window.__recorderInstance;
        if (recorder && !window.__isPlayingMessage) {
            recorder.recordOutgoingMessage(data);
        }
        return OriginalSend.call(this, data);
    };

    OriginalWebSocket.prototype.addEventListener = function (type, listener, options) {
        if (type === 'message') {
            window.__wsListeners.push({ ws: this, listener: listener });

            const wrappedListener = function (event) {
                const recorder = window.__recorderInstance;
                if (recorder && event.data && !window.__isPlayingMessage) {
                    recorder.recordIncomingMessage(event.data);
                }
                listener.call(this, event);
            };
            return OriginalAddEventListener.call(this, type, wrappedListener, options);
        }
        return OriginalAddEventListener.call(this, type, listener, options);
    };

    let onmessageHandler = null;
    Object.defineProperty(OriginalWebSocket.prototype, 'onmessage', {
        get: function () {
            return onmessageHandler;
        },
        set: function (handler) {
            onmessageHandler = handler;

            if (handler) {
                const wrappedHandler = function (event) {
                    const recorder = window.__recorderInstance;
                    if (recorder && event.data && !window.__isPlayingMessage) {
                        recorder.recordIncomingMessage(event.data);
                    }
                    handler.call(this, event);
                };
                OriginalAddEventListener.call(this, 'message', wrappedHandler);
            }
        },
        enumerable: true,
        configurable: true
    });

    window.WebSocket = function (...args) {
        if (window.__fakeServerMode) {
            console.log('[Recorder] Creating FAKE WebSocket for replay');
            return createFakeWebSocket(args[0]);
        }

        const ws = new OriginalWebSocket(...args);
        window.__allWebSockets.push(ws);
        console.log('[Recorder] WebSocket created:', args[0]);
        return ws;
    };

    window.WebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(window.WebSocket, OriginalWebSocket);

    function createFakeWebSocket(url) {
        const fake = {
            url: url,
            readyState: 0,
            bufferedAmount: 0,
            extensions: '',
            protocol: '',
            binaryType: 'arraybuffer',

            listeners: {
                open: [],
                message: [],
                error: [],
                close: []
            },

            addEventListener: function (type, listener, options) {
                if (this.listeners[type]) {
                    this.listeners[type].push(listener);
                }
            },

            removeEventListener: function (type, listener, options) {
                if (this.listeners[type]) {
                    const idx = this.listeners[type].indexOf(listener);
                    if (idx !== -1) this.listeners[type].splice(idx, 1);
                }
            },

            send: function (data) {
                console.log('[FakeWS] Send (ignored):', data);
            },

            close: function (code, reason) {
                this.readyState = 3;
                const closeEvent = new CloseEvent('close', {
                    code: code || 1000,
                    reason: reason || '',
                    wasClean: true
                });
                this.listeners.close.forEach(fn => fn.call(this, closeEvent));
                if (this.onclose) this.onclose(closeEvent);
            },

            dispatchEvent: function (event) {
                const type = event.type;
                if (this.listeners[type]) {
                    this.listeners[type].forEach(fn => fn.call(this, event));
                }
                return true;
            }
        };

        setTimeout(() => {
            fake.readyState = 1;
            const openEvent = new Event('open');
            fake.listeners.open.forEach(fn => fn.call(fake, openEvent));
            if (fake.onopen) fake.onopen(openEvent);

            console.log('[FakeWS] Connection opened, starting playback...');

            const recorder = window.__recorderInstance;
            if (recorder && window.__playingRecording) {
                recorder.startAutoPlayback(fake);
            }
        }, 100);

        window.__allWebSockets.push(fake);
        return fake;
    }

    function keepOverlayHidden() {
        if (window.__hideOverlay) {
            const overlay = document.getElementById('overlay');
            if (overlay) {
                overlay.style.display = 'none !important';
            }
        }
        requestAnimationFrame(keepOverlayHidden);
    }
    keepOverlayHidden();

    function sanitizeSensitiveData(str) {
        try {
            const obj = JSON.parse(str);

            if (obj.data) {
                if (obj.data.ecp_key !== undefined) {
                    obj.data.ecp_key = '';
                }
                if (obj.data.key !== undefined) {
                    obj.data.key = '';
                }
                if (obj.data.steamid !== undefined) {
                    obj.data.steamid = null;
                }
            }

            return JSON.stringify(obj);
        } catch (e) {
            return str;
        }
    }

    class GameRecorder {
        constructor() {
            this.isRecording = false;
            this.isPlayback = false;
            this.isPaused = false;
            this.recordedMessages = [];
            this.playbackIndex = 0;
            this.playbackSpeed = 1.0;
            this.autoRecordEnabled = true;
            this.autoStarted = false;
            this.fakeWs = null;
            this.uiVisible = false;
            this.recordingStartTime = null;
            this.isOver100Seconds = false;
            this.mouseBlockHandlers = null;

            window.__recorderInstance = this;
            this.setupUI();
            this.setupKeyboardShortcuts();
        }
        recordIncomingMessage(data) {
            const dataInfo = this.identifyData(data);

            if (!this.autoStarted && this.autoRecordEnabled) {
                if (this.shouldAutoStart(data)) {
                    this.autoStarted = true;
                    this.startRecording();
                    const now = new Date();
                    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
                    document.getElementById('recording-name').value = `session_${timeStr}`;
                    document.getElementById('record-status').textContent = '🔴 AUTO (↓)';
                }
            }

            if (this.isRecording) {
                this.recordedMessages.push({
                    type: 'in',
                    rawData: data,
                    timestamp: Date.now()
                });
                this.updateRecordStatus();
                this.checkAutoSave();
            }
        }

        recordOutgoingMessage(data) {
            const dataInfo = this.identifyData(data);

            if (!this.autoStarted && this.autoRecordEnabled) {
                if (this.shouldAutoStart(data)) {
                    this.autoStarted = true;
                    this.startRecording();
                    const now = new Date();
                    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
                    document.getElementById('recording-name').value = `session_${timeStr}`;
                    document.getElementById('record-status').textContent = '🔴 AUTO (↑)';
                }
            }

            if (this.isRecording) {
                this.recordedMessages.push({
                    type: 'out',
                    rawData: data,
                    timestamp: Date.now()
                });
                this.updateRecordStatus();
                this.checkAutoSave();
            }
        }

        checkAutoSave() {
            if (!this.isRecording || !this.recordingStartTime) return;
            if (this.recordedMessages.length === 0) return;

            const currentTime = this.recordedMessages[this.recordedMessages.length - 1].timestamp;
            const baseTime = this.recordedMessages[0].timestamp;
            const duration = (currentTime - baseTime) / 1000;

            if (duration >= 100 && !this.isOver100Seconds) {
                this.isOver100Seconds = true;
                document.getElementById('record-status').textContent = '⚠️ 100s! Save as FILE ONLY';
                document.getElementById('btn-save').style.background = '#ff6600';
            }
        }

        identifyData(data) {
            if (data instanceof Blob) {
                return { type: 'Blob', size: data.size };
            } else if (data instanceof ArrayBuffer) {
                return { type: 'ArrayBuffer', size: data.byteLength };
            } else if (ArrayBuffer.isView(data)) {
                return { type: 'TypedArray', size: data.byteLength };
            } else if (typeof data === 'string') {
                return { type: 'string', size: data.length };
            }
            return { type: 'unknown', size: 0 };
        }

        async serializeDataAsync(data) {
            if (data instanceof Blob) {
                const arrayBuffer = await data.arrayBuffer();
                return {
                    type: 'buffer',
                    value: Array.from(new Uint8Array(arrayBuffer))
                };
            } else if (data instanceof ArrayBuffer) {
                return {
                    type: 'buffer',
                    value: Array.from(new Uint8Array(data))
                };
            } else if (ArrayBuffer.isView(data)) {
                return {
                    type: 'buffer',
                    value: Array.from(data)
                };
            } else if (typeof data === 'string') {
                const sanitized = sanitizeSensitiveData(data);
                return {
                    type: 'string',
                    value: sanitized
                };
            }
            return {
                type: 'string',
                value: String(data)
            };
        }

        deserializeData(serialized) {
            if (serialized.type === 'buffer') {
                const arrayBuffer = new Uint8Array(serialized.value).buffer;
                return new Blob([arrayBuffer]);
            }
            return serialized.value;
        }

        shouldAutoStart(data) {
            if (data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                return true;
            }
            if (typeof data === 'string') {
                const lower = data.toLowerCase();
                if (lower === 'ping' || lower === 'pong' || data === '2' || data === '3') return false;
                return data.length >= 5;
            }
            return false;
        }

        setupUI() {
            const container = document.createElement('div');
            container.id = 'recorder-ui';
            container.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
                background: rgba(0, 0, 0, 0.95);
                padding: 15px;
                border-radius: 8px;
                border: 2px solid #00ff00;
                font-family: 'Play';
                color: #0f0;
                min-width: 320px;
                max-width: 400px;
                box-shadow: 0 0 20px rgba(0, 255, 0, 0.5);
                display: none;
            `;

            container.innerHTML = `
                <div style="font-weight: bold; color: #0f0; font-size: 14px; margin-bottom: 10px;">🎮 RECORDER v1.8.4 (Shift+R)</div>
                
                <div style="border-bottom: 1px solid #0f0; margin: 10px 0; padding: 10px 0;">
                    <div style="font-size: 12px; margin-bottom: 8px;">📝 RECORDING:</div>
                    <div style="display: flex; gap: 5px;">
                        <button id="btn-record" style="flex: 1; padding: 8px; background: #0f0; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">⚫ START</button>
                        <button id="btn-stop" disabled style="flex: 1; padding: 8px; background: #333; color: #0f0; border: 1px solid #0f0; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">⏹ STOP</button>
                    </div>
                    <div style="display: flex; gap: 5px; align-items: center; margin: 8px 0;">
                        <input type="checkbox" id="auto-record" checked style="width: 18px; height: 18px;">
                        <label for="auto-record" style="font-size: 11px; cursor: pointer;">🔄 Auto</label>
                    </div>
                    <input type="text" id="recording-name" placeholder="session_name" style="width: 95.5%; padding: 6px; margin: 5px 0; border: 1px solid #0f0; border-radius: 4px; background: #111; color: #0f0; font-family: monospace; font-size: 11px;">
                    <button id="btn-save" disabled style="width: 100%; padding: 8px; background: #0f0; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">💾 SAVE</button>
                    <div id="record-status" style="margin-top: 8px; font-size: 10px; color: #0f0; text-align: center;">Ready</div>
                </div>

                <div style="border-bottom: 1px solid #0f0; margin: 10px 0; padding: 10px 0;">
                    <div style="font-size: 12px; margin-bottom: 8px;">▶ PLAYBACK:</div>
                    <select id="recordings-list" style="width: 100%; padding: 6px; margin: 5px 0; border: 1px solid #0f0; border-radius: 4px; background: #111; color: #0f0; font-family: monospace; font-size: 11px;">
                        <option>-- Select --</option>
                    </select>
                    
                    <div style="display: flex; gap: 5px; margin: 8px 0;">
                        <button id="btn-replay" disabled style="flex: 1; padding: 8px; background: #ff8800; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">🎬 REPLAY</button>
                    </div>

                    <div style="display: flex; gap: 5px; margin: 8px 0;">
                        <button id="btn-pause" disabled style="flex: 1; padding: 8px; background: #0f0; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">⏸ PAUSE</button>
                        <button id="btn-stop-play" disabled style="flex: 1; padding: 8px; background: #0f0; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">⏹ STOP</button>
                    </div>

                    <div style="display: flex; gap: 5px; align-items: center; font-size: 10px;">
                        <label style="flex: 1;">Speed:</label>
                        <input type="range" id="speed-control" min="0.25" max="4" step="0.25" value="1" style="flex: 2;">
                        <span id="speed-display" style="width: 35px;">1x</span>
                    </div>

                    <div style="margin-top: 8px;">
                        <input type="range" id="timeline-scrubber" min="0" max="100" value="0" style="width: 100%; height: 4px;">
                        <div id="playback-time" style="font-size: 9px; color: #0f0; text-align: center; margin-top: 4px;">0s / 0s</div>
                    </div>

                    <div id="playback-info" style="margin-top: 8px; font-size: 9px; color: #888; padding: 8px; background: #111; border-radius: 4px; max-height: 60px; overflow-y: auto;">No selection</div>
                </div>

                <div style="display: flex; gap: 5px;">
                    <button id="btn-import" style="flex: 1; padding: 8px; background: #00ff00; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">📥 IMPORT</button>
                    <button id="btn-export" disabled style="flex: 1; padding: 8px; background: #00f; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">📤 EXP</button>
                    <button id="btn-delete" disabled style="flex: 1; padding: 8px; background: #f00; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px;">🗑 DEL</button>
                </div>
            `;

            document.body.appendChild(container);
            this.setupEventListeners();
            this.loadRecordingsList();
        }

        setupKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                if (e.shiftKey && (e.code === 'KeyR' || (e.key && e.key.toLowerCase() === 'r'))) {
                    e.preventDefault();
                    this.toggleUI();
                }
            });
        }

        toggleUI() {
            this.uiVisible = !this.uiVisible;
            const container = document.getElementById('recorder-ui');

            if (this.uiVisible) {
                container.style.display = 'block';
            } else {
                container.style.display = 'none';
            }
        }

        setupEventListeners() {
            document.getElementById('btn-record').addEventListener('click', () => this.startRecording());
            document.getElementById('btn-stop').addEventListener('click', () => this.stopRecording());
            document.getElementById('btn-save').addEventListener('click', () => this.saveRecording());
            document.getElementById('btn-replay').addEventListener('click', () => this.startReplayMode());
            document.getElementById('btn-pause').addEventListener('click', () => this.togglePause());
            document.getElementById('btn-stop-play').addEventListener('click', () => this.stopPlayback());
            document.getElementById('recordings-list').addEventListener('change', () => this.onRecordingSelected());
            document.getElementById('btn-delete').addEventListener('click', () => this.deleteRecording());
            document.getElementById('btn-export').addEventListener('click', () => this.exportRecording());
            document.getElementById('btn-import').addEventListener('click', () => this.importRecording());
            document.getElementById('auto-record').addEventListener('change', (e) => {
                this.autoRecordEnabled = e.target.checked;
                this.autoStarted = false;
                document.getElementById('record-status').textContent = e.target.checked ? 'Auto Ready' : 'Auto OFF';
            });
            document.getElementById('speed-control').addEventListener('input', (e) => {
                this.playbackSpeed = parseFloat(e.target.value);
                document.getElementById('speed-display').textContent = this.playbackSpeed.toFixed(2) + 'x';
            });
            document.getElementById('timeline-scrubber').addEventListener('input', (e) => {
                if (!this.isPlayback) return;
                const percent = parseFloat(e.target.value) / 100;
                this.seekTo(percent);
            });
        }

        startRecording() {
            if (this.isRecording) return;
            this.isRecording = true;
            this.recordingStartTime = Date.now();
            this.recordedMessages = [];
            this.isOver100Seconds = false;
            document.getElementById('btn-record').disabled = true;
            document.getElementById('btn-stop').disabled = false;
            document.getElementById('btn-save').disabled = true;
            document.getElementById('btn-save').style.background = '#0f0';
        }

        stopRecording() {
            if (!this.isRecording) return;
            this.isRecording = false;
            document.getElementById('btn-record').disabled = false;
            document.getElementById('btn-stop').disabled = true;
            document.getElementById('btn-save').disabled = false;

            if (this.recordedMessages.length === 0) {
                document.getElementById('record-status').textContent = '⚠️ No data';
                return;
            }

            const inCount = this.recordedMessages.filter(m => m.type === 'in').length;
            const outCount = this.recordedMessages.filter(m => m.type === 'out').length;
            const baseTime = this.recordedMessages[0].timestamp;
            const lastTime = this.recordedMessages[this.recordedMessages.length - 1].timestamp;
            const duration = (lastTime - baseTime) / 1000;

            document.getElementById('record-status').textContent = `✅ ↓${inCount} ↑${outCount} | ${duration.toFixed(1)}s`;
        }

        async saveRecording() {
            const name = document.getElementById('recording-name').value.trim() || 'unnamed';
            if (this.recordedMessages.length === 0) {
                alert('Nothing to save!');
                return;
            }

            const serializedMessages = [];
            for (const msg of this.recordedMessages) {
                const serialized = await this.serializeDataAsync(msg.rawData);
                serializedMessages.push({
                    type: msg.type,
                    data: serialized,
                    relativeTime: msg.timestamp - this.recordedMessages[0].timestamp
                });
            }

            const recordingData = {
                name: name,
                messages: serializedMessages,
                totalDuration: serializedMessages[serializedMessages.length - 1].relativeTime,
                messageCount: serializedMessages.length,
                version: 1
            };

            if (this.isOver100Seconds) {
                const json = JSON.stringify(recordingData, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${name}_${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);

                document.getElementById('record-status').textContent = '✅ Saved to FILE!';
                this.recordedMessages = [];
                this.isOver100Seconds = false;
            } else {
                const key = `rec_${Date.now()}_${name}`;
                localStorage.setItem(key, JSON.stringify(recordingData));

                document.getElementById('record-status').textContent = '✅ Saved in browser!';
                this.loadRecordingsList();
            }

            document.getElementById('recording-name').value = '';
            document.getElementById('btn-save').style.background = '#0f0';
            this.autoStarted = false;

            setTimeout(() => {
                document.getElementById('record-status').textContent = 'Ready';
            }, 1500);
        }

        startReplayMode() {
            const select = document.getElementById('recordings-list');
            const key = select.value;
            if (!key) return;

            const recordingData = JSON.parse(localStorage.getItem(key));
            window.__playingRecording = recordingData;
            window.__fakeServerMode = true;
            window.__hideOverlay = true;

            alert('Replay mode activated!\n\nNow join the game - it will replay the recording.\n\nRefresh the page after playback ends.');

            document.getElementById('playback-info').textContent = '🎬 REPLAY MODE ACTIVE';
        }

        startAutoPlayback(fakeWs) {
            this.fakeWs = fakeWs;
            this.isPlayback = true;
            this.isPaused = false;
            this.playbackIndex = 0;
            this.playbackStartTime = Date.now();

            this.blockUserMouseInput();
            console.log('[Recorder] User mouse input BLOCKED');

            document.getElementById('btn-pause').disabled = false;
            document.getElementById('btn-stop-play').disabled = false;

            this.playNextMessage();
        }

        playNextMessage() {
            if (!this.isPlayback || !window.__playingRecording) return;

            const messages = window.__playingRecording.messages;

            if (this.playbackIndex >= messages.length) {
                this.stopPlayback();
                return;
            }

            if (this.isPaused) {
                setTimeout(() => this.playNextMessage(), 50);
                return;
            }

            const currentMsg = messages[this.playbackIndex];
            const nextMsg = messages[this.playbackIndex + 1];

            const elapsedTime = (Date.now() - this.playbackStartTime) / this.playbackSpeed;
            const msgTime = currentMsg.relativeTime;

            if (elapsedTime >= msgTime) {
                if (currentMsg.type === 'in') {
                    this.deliverMessage(currentMsg);
                }

                this.playbackIndex++;
                this.updatePlaybackUI(window.__playingRecording);

                setTimeout(() => this.playNextMessage(), 0);
            } else {
                const delay = nextMsg
                    ? Math.max(1, (nextMsg.relativeTime - msgTime) / this.playbackSpeed)
                    : 16;
                setTimeout(() => this.playNextMessage(), Math.min(delay, 100));
            }
        }

        deliverMessage(msgData) {
            window.__isPlayingMessage = true;

            const data = this.deserializeData(msgData.data);

            if (window.__playingRecording && this.isPlayback) {
                const angle = this.extractAngleFromPacket(data);
                if (angle !== null) {
                    this.applyRotationFromPlayback(angle);
                }
            }

            if (this.fakeWs) {
                const event = new MessageEvent('message', {
                    data: data,
                    bubbles: false,
                    cancelable: false
                });

                this.fakeWs.listeners.message.forEach(fn => fn.call(this.fakeWs, event));
                if (this.fakeWs.onmessage) this.fakeWs.onmessage(event);
            } else {
                window.__wsListeners.forEach(item => {
                    try {
                        const event = new MessageEvent('message', {
                            data: data,
                            bubbles: false,
                            cancelable: false
                        });
                        item.listener.call(item.ws, event);
                    } catch (e) {
                        console.error('[Recorder] Error in listener:', e);
                    }
                });

                window.__allWebSockets.forEach(ws => {
                    try {
                        if (ws.onmessage) {
                            const event = new MessageEvent('message', {
                                data: data,
                                bubbles: false,
                                cancelable: false
                            });
                            ws.onmessage(event);
                        }
                    } catch (e) { }
                });
            }

            window.__isPlayingMessage = false;
        }

        extractAngleFromPacket(data) {
            try {
                let packet = null;

                if (data instanceof Blob) {
                    return null;
                }

                if (data instanceof ArrayBuffer) {
                    const view = new Uint8Array(data);
                    if (view.length < 2) return null;
                    packet = (view[0] << 8) | view[1];
                } else if (ArrayBuffer.isView(data)) {
                    const view = new Uint8Array(data);
                    if (view.length < 2) return null;
                    packet = (view[0] << 8) | view[1];
                } else if (typeof data === 'string') {
                    try {
                        const obj = JSON.parse(data);
                        if (obj.r !== undefined) {
                            return obj.r % 360;
                        }
                    } catch (e) { }
                    return null;
                }

                if (packet === null) return null;

                const angle = packet % 360;
                return angle;
            } catch (e) {
                return null;
            }
        }

        applyRotationFromPlayback(angle) {
            try {
                const canvas = document.querySelector('canvas');
                if (!canvas) return;

                const rect = canvas.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;

                const rad = (angle * Math.PI) / 180;
                const distance = 100;
                const mouseX = centerX + distance * Math.cos(rad);
                const mouseY = centerY + distance * Math.sin(rad);

                const moveEvent = new MouseEvent('mousemove', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: mouseX,
                    clientY: mouseY,
                    screenX: mouseX,
                    screenY: mouseY
                });

                document.dispatchEvent(moveEvent);
                canvas.dispatchEvent(moveEvent);
            } catch (e) {
                console.error('[Recorder] Error applying rotation:', e);
            }
        }

        blockUserMouseInput() {
            const handler = (e) => {
                if (window.__playingRecording && this.isPlayback) {
                    e.stopPropagation();
                    e.preventDefault();
                }
            };

            document.addEventListener('mousemove', handler, true);
            document.addEventListener('mousedown', handler, true);
            document.addEventListener('mouseup', handler, true);
            document.addEventListener('mouseenter', handler, true);

            this.mouseBlockHandlers = { handler, events: ['mousemove', 'mousedown', 'mouseup', 'mouseenter'] };
        }

        unblockUserMouseInput() {
            if (!this.mouseBlockHandlers) return;

            this.mouseBlockHandlers.events.forEach(event => {
                document.removeEventListener(event, this.mouseBlockHandlers.handler, true);
            });

            this.mouseBlockHandlers = null;
        }

        updatePlaybackUI(recordingData) {
            const msgs = recordingData.messages;
            if (this.playbackIndex === 0) return;

            const currentMsg = msgs[this.playbackIndex - 1];
            const progress = (currentMsg.relativeTime / recordingData.totalDuration) * 100;

            document.getElementById('timeline-scrubber').value = progress;

            const currentSec = (currentMsg.relativeTime / 1000).toFixed(1);
            const totalSec = (recordingData.totalDuration / 1000).toFixed(1);
            document.getElementById('playback-time').textContent = `${currentSec}s / ${totalSec}s`;
        }

        togglePause() {
            this.isPaused = !this.isPaused;
            const btn = document.getElementById('btn-pause');
            btn.textContent = this.isPaused ? '▶ RES' : '⏸ PAU';
            btn.style.background = this.isPaused ? '#ff8800' : '#0f0';
        }

        stopPlayback() {
            this.isPlayback = false;
            this.isPaused = false;
            window.__playingRecording = null;
            window.__fakeServerMode = false;
            window.__hideOverlay = false;

            this.unblockUserMouseInput();
            console.log('[Recorder] User mouse input UNBLOCKED');

            const overlay = document.getElementById('overlay');
            if (overlay) {
                overlay.style.display = 'block';
            }

            document.getElementById('btn-pause').disabled = true;
            document.getElementById('btn-stop-play').disabled = true;
            document.getElementById('btn-pause').textContent = '⏸ PAUSE';
            document.getElementById('btn-pause').style.background = '#0f0';
            document.getElementById('timeline-scrubber').value = 0;
            document.getElementById('playback-time').textContent = '0s / 0s';

            if (this.fakeWs) {
                this.fakeWs.close();
                this.fakeWs = null;
            }
        }

        seekTo(percent) {
            const select = document.getElementById('recordings-list');
            const data = JSON.parse(localStorage.getItem(select.value));
            const targetTime = data.totalDuration * percent;

            this.playbackIndex = data.messages.findIndex(m => m.relativeTime >= targetTime);
            if (this.playbackIndex < 0) this.playbackIndex = 0;

            this.playbackStartTime = Date.now() - (targetTime / this.playbackSpeed);
        }

        loadRecordingsList() {
            const select = document.getElementById('recordings-list');
            Array.from(select.options).slice(1).forEach(opt => opt.remove());

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('rec_')) {
                    try {
                        const data = JSON.parse(localStorage.getItem(key));
                        const opt = document.createElement('option');
                        opt.value = key;
                        const dur = (data.totalDuration / 1000).toFixed(1);
                        const inCount = data.messages.filter(m => m.type === 'in').length;
                        const outCount = data.messages.filter(m => m.type === 'out').length;
                        opt.textContent = `${data.name} (${dur}s) ↓${inCount}↑${outCount}`;
                        select.appendChild(opt);
                    } catch (e) { }
                }
            }
        }

        onRecordingSelected() {
            const select = document.getElementById('recordings-list');
            const hasSelection = select.value !== '';
            document.getElementById('btn-replay').disabled = !hasSelection;
            document.getElementById('btn-delete').disabled = !hasSelection;
            document.getElementById('btn-export').disabled = !hasSelection;

            if (hasSelection) {
                const data = JSON.parse(localStorage.getItem(select.value));
                const dur = (data.totalDuration / 1000).toFixed(1);
                const inCount = data.messages.filter(m => m.type === 'in').length;
                const outCount = data.messages.filter(m => m.type === 'out').length;
                document.getElementById('playback-info').textContent =
                    `📹 ${data.name}\n⏱ ${dur}s | ↓${inCount}↑${outCount}`;
            }
        }

        deleteRecording() {
            const select = document.getElementById('recordings-list');
            const key = select.value;
            if (!key) return;

            const data = JSON.parse(localStorage.getItem(key));
            if (confirm(`Delete "${data.name}"?`)) {
                localStorage.removeItem(key);
                this.loadRecordingsList();
                this.onRecordingSelected();
            }
        }

        exportRecording() {
            const select = document.getElementById('recordings-list');
            const key = select.value;
            const data = JSON.parse(localStorage.getItem(key));

            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${data.name}_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
        }

        importRecording() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';

            input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const recordingData = JSON.parse(event.target.result);

                        if (!recordingData.messages || !recordingData.name) {
                            alert('Invalid recording file!');
                            return;
                        }

                        const key = `rec_${Date.now()}_${recordingData.name}`;
                        localStorage.setItem(key, JSON.stringify(recordingData));

                        this.loadRecordingsList();
                        alert(`✅ Imported: ${recordingData.name}`);
                    } catch (err) {
                        alert('Error importing file: ' + err.message);
                    }
                };
                reader.readAsText(file);
            };

            input.click();
        }

        updateRecordStatus() {
            if (!this.isRecording) return;
            const inCount = this.recordedMessages.filter(m => m.type === 'in').length;
            const outCount = this.recordedMessages.filter(m => m.type === 'out').length;
            const baseTime = this.recordedMessages[0].timestamp;
            const lastTime = this.recordedMessages[this.recordedMessages.length - 1].timestamp;
            const dur = (lastTime - baseTime) / 1000;
            document.getElementById('record-status').textContent = `🔴 ↓${inCount} ↑${outCount} | ${dur.toFixed(1)}s`;
        }
    }

    window.__gameRecorder = new GameRecorder();
    console.log('[Recorder] v1.8.4 - Replay mode with user data protection');
})();
