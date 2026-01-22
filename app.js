class MotionSoundApp {
    constructor() {
        this.isRunning = false;
        this.stepCount = 0;
        this.jumpCount = 0;
        
        // 歩行検知用のパラメータ
        this.stepThreshold = 1.5;
        this.lastStepTime = 0;
        this.stepCooldown = 300; // ミリ秒
        
        // ジャンプ検知用のパラメータ
        this.jumpThreshold = 2.5;
        this.lastJumpTime = 0;
        this.jumpCooldown = 500; // ミリ秒
        
        // 前回の加速度
        this.lastAccel = { x: 0, y: 0, z: 0 };
        
        this.initElements();
        this.initAudio();
        this.initEventListeners();
    }
    
    initElements() {
        this.statusEl = document.getElementById('status');
        this.stepCountEl = document.getElementById('stepCount');
        this.jumpCountEl = document.getElementById('jumpCount');
        this.accelXEl = document.getElementById('accelX');
        this.accelYEl = document.getElementById('accelY');
        this.accelZEl = document.getElementById('accelZ');
        this.startBtn = document.getElementById('startBtn');
        this.stopBtn = document.getElementById('stopBtn');
    }
    
    initAudio() {
        // Web Audio APIを使用して音を生成
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    // 歩行音を生成
    playStepSound() {
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.frequency.value = 200;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
        
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.1);
    }
    
    // ジャンプ音を生成
    playJumpSound() {
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.frequency.setValueAtTime(400, this.audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(800, this.audioContext.currentTime + 0.2);
        oscillator.type = 'square';
        
        gainNode.gain.setValueAtTime(0.4, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
        
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.2);
    }
    
    initEventListeners() {
        this.startBtn.addEventListener('click', () => this.start());
        this.stopBtn.addEventListener('click', () => this.stop());
    }
    
    async start() {
        try {
            // 加速度センサーへのアクセス許可をリクエスト
            if (typeof DeviceMotionEvent.requestPermission === 'function') {
                const permission = await DeviceMotionEvent.requestPermission();
                if (permission !== 'granted') {
                    alert('加速度センサーへのアクセスが拒否されました');
                    return;
                }
            }
            
            this.isRunning = true;
            this.statusEl.textContent = '動作中';
            this.startBtn.disabled = true;
            this.stopBtn.disabled = false;
            
            // AudioContextを再開（ユーザーインタラクション後に必要）
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            window.addEventListener('devicemotion', this.handleMotion.bind(this));
            
        } catch (error) {
            console.error('センサーの起動に失敗:', error);
            alert('センサーの起動に失敗しました: ' + error.message);
        }
    }
    
    stop() {
        this.isRunning = false;
        this.statusEl.textContent = '停止中';
        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
        
        window.removeEventListener('devicemotion', this.handleMotion.bind(this));
    }
    
    handleMotion(event) {
        if (!this.isRunning) return;
        
        const accel = event.accelerationIncludingGravity;
        if (!accel) return;
        
        const x = accel.x || 0;
        const y = accel.y || 0;
        const z = accel.z || 0;
        
        // 表示を更新
        this.accelXEl.textContent = x.toFixed(2);
        this.accelYEl.textContent = y.toFixed(2);
        this.accelZEl.textContent = z.toFixed(2);
        
        // 加速度の変化量を計算
        const deltaX = Math.abs(x - this.lastAccel.x);
        const deltaY = Math.abs(y - this.lastAccel.y);
        const deltaZ = Math.abs(z - this.lastAccel.z);
        
        const totalDelta = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
        
        const now = Date.now();
        
        // ジャンプ検知（Z軸の大きな変化）
        if (deltaZ > this.jumpThreshold && now - this.lastJumpTime > this.jumpCooldown) {
            this.jumpCount++;
            this.jumpCountEl.textContent = this.jumpCount;
            this.playJumpSound();
            this.lastJumpTime = now;
            this.statusEl.textContent = 'ジャンプ！';
            setTimeout(() => {
                if (this.isRunning) this.statusEl.textContent = '動作中';
            }, 500);
        }
        // 歩行検知（全体的な揺れ）
        else if (totalDelta > this.stepThreshold && now - this.lastStepTime > this.stepCooldown) {
            this.stepCount++;
            this.stepCountEl.textContent = this.stepCount;
            this.playStepSound();
            this.lastStepTime = now;
        }
        
        // 前回の値を保存
        this.lastAccel = { x, y, z };
    }
}

// アプリを初期化
document.addEventListener('DOMContentLoaded', () => {
    new MotionSoundApp();
});
