class MotionSoundApp {
  constructor() {
    this.isRunning = false;

    // カウント
    this.stepCount = 0;
    this.jumpCount = 0;
    this.greetCount = 0;

    // 検知（端末差が出るので、あとで調整しやすいようにまとめてある）
    this.cfg = {
      // 歩行（小鼓ポンポン）
      step: {
        threshold: 1.25,   // 小さすぎると揺れで鳴りまくる
        cooldown: 240,     // 速歩でも連打しすぎない間隔
        armRatio: 0.55,    // しきい値の何倍まで落ちたら再武装するか
      },
      // ジャンプ
      jump: {
        threshold: 3.2,
        cooldown: 650,
      },
      // 持ち上げ→切り捨て（2段階ジェスチャ）
      greet: {
        upThreshold: 4.0,      // 最初の「持ち上げ」スパイク
        downThreshold: 6.0,    // 次の「切り捨て」逆向きスパイク
        maxGapMs: 450,         // 2動作の間隔（短いほど意図的になる）
        cooldown: 2200,        // 誤発火防止
      }
    };

    // センサー処理用
    this.last = {
      x: 0, y: 0, z: 0,
      mag: 0,
      stepArmed: true,
      lastStepTime: 0,
      lastJumpTime: 0,
      lastGreetTime: 0,
    };

    // 重力推定（acceleration が取れない端末向け）
    this.gravity = { x: 0, y: 0, z: 0 };
    this.gravityAlpha = 0.82; // 0.8〜0.9くらいが無難

    // greet（状態機械）
    this.greetState = {
      stage: 0,          // 0:待機 1:持ち上げ検出済
      axis: "y",
      sign: 1,
      t0: 0,
    };

    // Wake Lock
    this.wakeLock = null;

    // UI & Audio
    this.initElements();
    this.initAudio();
    this.initEventListeners();

    // ★重要：同じ関数参照で add/remove できるように保持
    this.boundHandleMotion = this.handleMotion.bind(this);
    this.boundOnVisibilityChange = this.onVisibilityChange.bind(this);

    // TTS 初期化（iOS向けに voices を一度掴みに行く）
    if ("speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
    }
  }

  initElements() {
    this.statusEl = document.getElementById("status");
    this.stepCountEl = document.getElementById("stepCount");
    this.jumpCountEl = document.getElementById("jumpCount");
    this.greetCountEl = document.getElementById("greetCount");
    this.lastEventEl = document.getElementById("lastEvent");

    this.accelXEl = document.getElementById("accelX");
    this.accelYEl = document.getElementById("accelY");
    this.accelZEl = document.getElementById("accelZ");

    this.startBtn = document.getElementById("startBtn");
    this.stopBtn = document.getElementById("stopBtn");

    this.keepAwakeEl = document.getElementById("keepAwake");
    this.ttsEnabledEl = document.getElementById("ttsEnabled");
    this.volumeEl = document.getElementById("volume");
    this.volumeValueEl = document.getElementById("volumeValue");
  }

  initAudio() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.audioContext.createGain();
    this.masterGain.connect(this.audioContext.destination);

    // 音量（0〜1）
    this.setVolumeFromUI();

    // ノイズ（小鼓の「皮っぽさ」用）
    this.noiseBuffer = this.createNoiseBuffer(0.12);
  }

  initEventListeners() {
    this.startBtn.addEventListener("click", () => this.start());
    this.stopBtn.addEventListener("click", () => this.stop());

    this.volumeEl.addEventListener("input", () => {
      this.setVolumeFromUI();
      this.volumeValueEl.textContent = String(this.volumeEl.value);
    });

    this.keepAwakeEl.addEventListener("change", async () => {
      if (!this.isRunning) return;
      if (this.keepAwakeEl.checked) {
        await this.requestWakeLock();
      } else {
        await this.releaseWakeLock();
      }
    });

    document.addEventListener("visibilitychange", this.boundOnVisibilityChange);
  }

  setVolumeFromUI() {
    const v = Number(this.volumeEl?.value ?? 70);
    const norm = Math.max(0, Math.min(1, v / 100));
    this.masterGain.gain.value = norm;
  }

  async start() {
    try {
      // iOS: センサー許可
      if (typeof DeviceMotionEvent?.requestPermission === "function") {
        const permission = await DeviceMotionEvent.requestPermission();
        if (permission !== "granted") {
          alert("加速度センサーへのアクセスが拒否されました");
          return;
        }
      }

      this.isRunning = true;
      this.statusEl.textContent = "動作中";
      this.startBtn.disabled = true;
      this.stopBtn.disabled = false;

      // AudioContext 再開
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      // Wake Lock（可能なら）
      if (this.keepAwakeEl.checked) {
        await this.requestWakeLock();
      }

      // リスナー登録（★保持した参照を使う）
      window.addEventListener("devicemotion", this.boundHandleMotion, { passive: true });

      this.setLastEvent("開始");
    } catch (error) {
      console.error("センサーの起動に失敗:", error);
      alert("センサーの起動に失敗しました: " + (error?.message ?? error));
    }
  }

  async stop() {
    this.isRunning = false;
    this.statusEl.textContent = "停止中";
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;

    // リスナー解除（★同じ参照で外す）
    window.removeEventListener("devicemotion", this.boundHandleMotion);

    await this.releaseWakeLock();
    this.setLastEvent("停止");
  }

  async onVisibilityChange() {
    // 画面復帰時に Wake Lock が外れてたら再取得（対応端末のみ）
    if (!this.isRunning) return;
    if (!this.keepAwakeEl.checked) return;

    if (document.visibilityState === "visible") {
      await this.requestWakeLock();
    }
  }

  async requestWakeLock() {
    try {
      if (!("wakeLock" in navigator)) return;
      // すでに持ってるなら何もしない
      if (this.wakeLock) return;

      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => {
        this.wakeLock = null;
      });
    } catch (e) {
      // 取れない端末もある（iOS Safari など）
      this.wakeLock = null;
    }
  }

  async releaseWakeLock() {
    try {
      if (this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch (_) {
      this.wakeLock = null;
    }
  }

  // ====== 検知ループ ======

  handleMotion(event) {
    if (!this.isRunning) return;

    const a = this.getLinearAcceleration(event);
    if (!a) return;

    const x = a.x, y = a.y, z = a.z;

    // UI 更新
    this.accelXEl.textContent = x.toFixed(2);
    this.accelYEl.textContent = y.toFixed(2);
    this.accelZEl.textContent = z.toFixed(2);

    const mag = Math.sqrt(x * x + y * y + z * z);
    const now = Date.now();

    // 1) 持ち上げ→切り捨て（最優先）
    if (this.detectGreetGesture({ x, y, z }, now)) {
      return;
    }

    // 2) ジャンプ
    if (mag > this.cfg.jump.threshold && now - this.last.lastJumpTime > this.cfg.jump.cooldown) {
      this.last.lastJumpTime = now;
      this.jumpCount++;
      this.jumpCountEl.textContent = String(this.jumpCount);
      this.playJumpSound();
      this.flashStatus("ジャンプ！");
      this.setLastEvent("ジャンプ");
      // ジャンプを歩行扱いにしないため、ここで終了
      this.last.mag = mag;
      return;
    }

    // 3) 歩行（ピーク検知の簡易版：再武装→閾値超えで1回鳴らす）
    const step = this.cfg.step;
    if (mag < step.threshold * step.armRatio) {
      this.last.stepArmed = true;
    }
    if (this.last.stepArmed && mag > step.threshold && now - this.last.lastStepTime > step.cooldown) {
      this.last.stepArmed = false;
      this.last.lastStepTime = now;
      this.stepCount++;
      this.stepCountEl.textContent = String(this.stepCount);
      this.playKotsuzumiPonPon();
      this.setLastEvent("歩行（ポンポン）");
    }

    this.last.mag = mag;
  }

  flashStatus(text) {
    this.statusEl.textContent = text;
    setTimeout(() => {
      if (this.isRunning) this.statusEl.textContent = "動作中";
    }, 450);
  }

  setLastEvent(text) {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const ss = String(t.getSeconds()).padStart(2, "0");
    this.lastEventEl.textContent = `${hh}:${mm}:${ss} ${text}`;
  }

  // ====== 加速度（重力除去） ======

  getLinearAcceleration(event) {
    // 1) acceleration が取れるなら最優先（重力除去済）
    const acc = event.acceleration;
    if (acc && (acc.x != null || acc.y != null || acc.z != null)) {
      return {
        x: acc.x ?? 0,
        y: acc.y ?? 0,
        z: acc.z ?? 0,
      };
    }

    // 2) accelerationIncludingGravity から重力を推定して引く
    const inc = event.accelerationIncludingGravity;
    if (!inc) return null;

    const ix = inc.x ?? 0;
    const iy = inc.y ?? 0;
    const iz = inc.z ?? 0;

    // ローパスで重力を追従
    const a = this.gravityAlpha;
    this.gravity.x = a * this.gravity.x + (1 - a) * ix;
    this.gravity.y = a * this.gravity.y + (1 - a) * iy;
    this.gravity.z = a * this.gravity.z + (1 - a) * iz;

    return {
      x: ix - this.gravity.x,
      y: iy - this.gravity.y,
      z: iz - this.gravity.z,
    };
  }

  // ====== ジェスチャ：持ち上げ→切り捨て ======
  detectGreetGesture(vec, now) {
    if (now - this.last.lastGreetTime < this.cfg.greet.cooldown) return false;

    const axes = [
      { name: "x", v: vec.x },
      { name: "y", v: vec.y },
      { name: "z", v: vec.z },
    ];

    // 一番強い軸
    axes.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const top = axes[0];

    const g = this.cfg.greet;
    const state = this.greetState;

    // stage 0: 最初のスパイク待ち
    if (state.stage === 0) {
      if (Math.abs(top.v) > g.upThreshold) {
        state.stage = 1;
        state.axis = top.name;
        state.sign = Math.sign(top.v) || 1;
        state.t0 = now;
      }
      return false;
    }

    // stage 1: 逆向きスパイク待ち
    if (state.stage === 1) {
      if (now - state.t0 > g.maxGapMs) {
        // タイムアウト
        state.stage = 0;
        return false;
      }

      const currentAxisVal = vec[state.axis];
      const oppositeStrength = (-state.sign) * currentAxisVal; // 逆向きなら正で大きくなる

      if (oppositeStrength > g.downThreshold) {
        // 成功
        state.stage = 0;
        this.last.lastGreetTime = now;

        this.greetCount++;
        this.greetCountEl.textContent = String(this.greetCount);

        this.playGreetSound();
        this.sayGreet();
        this.flashStatus("あけおめ！");
        this.setLastEvent("持ち上げ→切り捨て（あけおめ）");
        return true;
      }
    }

    return false;
  }

  sayGreet() {
    const text = "新年あけましておめでとうございます。";
    if (!this.ttsEnabledEl.checked) return;

    if (!("speechSynthesis" in window)) {
      // TTS 非対応
      this.statusEl.textContent = text;
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      u.rate = 1.04;
      u.pitch = 1.0;
      u.volume = Math.max(0, Math.min(1, (Number(this.volumeEl.value) / 100)));
      window.speechSynthesis.speak(u);
    } catch (e) {
      // 端末によっては失敗するので表示だけでも
      this.statusEl.textContent = text;
    }
  }

  // ====== サウンド ======

  // 小鼓っぽい「ポンポン」（二連打）
  playKotsuzumiPonPon() {
    const t = this.audioContext.currentTime;
    this.playKotsuzumiHit(t);
    this.playKotsuzumiHit(t + 0.085);
  }

  playKotsuzumiHit(when) {
    const ctx = this.audioContext;

    const out = ctx.createGain();
    out.connect(this.masterGain);

    // 皮っぽいアタック（ノイズ）
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(1600, when);
    band.Q.setValueAtTime(7.5, when);

    // 胴鳴り（低めのサイン）
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(260, when);
    osc.frequency.exponentialRampToValueAtTime(190, when + 0.07);

    // エンベロープ（短い打音）
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(0.9, when + 0.004);
    out.gain.exponentialRampToValueAtTime(0.0001, when + 0.10);

    noise.connect(band);
    band.connect(out);
    osc.connect(out);

    noise.start(when);
    noise.stop(when + 0.11);

    osc.start(when);
    osc.stop(when + 0.11);
  }

  // ジャンプ音：ポンッ→ヒュン（軽い跳ね）
  playJumpSound() {
    const ctx = this.audioContext;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    osc.connect(g);
    g.connect(this.masterGain);

    osc.type = "triangle";
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(260, t + 0.22);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);

    osc.start(t);
    osc.stop(t + 0.28);
  }

  // あけおめ発火時：キラッと短いベル
  playGreetSound() {
    const ctx = this.audioContext;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    osc.connect(g);
    g.connect(this.masterGain);

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.18);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.8, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

    osc.start(t);
    osc.stop(t + 0.25);
  }

  createNoiseBuffer(seconds) {
    const ctx = this.audioContext;
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const buffer = ctx.createBuffer(1, len, sr);
    const data = buffer.getChannelData(0);

    // 少しだけ減衰するホワイトノイズ
    for (let i = 0; i < len; i++) {
      const decay = 1 - i / len;
      data[i] = (Math.random() * 2 - 1) * decay;
    }
    return buffer;
  }
}

// 初期化
document.addEventListener("DOMContentLoaded", () => {
  new MotionSoundApp();
});
