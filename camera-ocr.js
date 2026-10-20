/*!
 * CameraOCR – quét chữ bằng camera, điền vào ô nhập liệu.
 * Chạy thuần trên trình duyệt (Tesseract.js, WebAssembly): ảnh KHÔNG gửi lên server.
 *
 * Cách dùng nhanh:
 *   <script src="camera-ocr.js" defer></script>
 *   <input type="text" data-camera-ocr>              <!-- tự thêm nút "Quét" -->
 *
 * Hoặc bằng JS:
 *   CameraOCR.attach(document.querySelector('#ma'), { lang: 'vie', psm: 7 });
 *   CameraOCR.scan({ lang: 'vie' }).then(text => ...);   // không cần ô nhập
 *
 * Lưu ý: camera chỉ hoạt động trên HTTPS (hoặc localhost).
 */
(function (global) {
  'use strict';

  var TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  // Model huấn luyện "best" chính xác hơn bản mặc định của Tesseract.js, nhất là dấu tiếng Việt.
  var BEST_LANG_PATH = { vie: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/vie/4.0.0_best_int' };

  var DEFAULTS = {
    lang: 'vie',            // 'vie', 'eng', 'vie+eng' ...
    psm: 7,                 // 7 = một dòng; 6 = một khối nhiều dòng
    multiline: false,       // true: giữ nhiều dòng (nối bằng khoảng trắng), tự đặt psm = 6
    minConfidence: 60,      // 0-100, độ tin cậy tối thiểu để tự động nhận
    binarize: true,         // lọc nền thành đen/trắng theo từng vùng (chống bóng, ánh sáng không đều)
    stableReads: 2,         // số lần quét liên tiếp cho kết quả giống nhau mới tự điền
    intervalMs: 350,        // nghỉ giữa các lần quét
    charWhitelist: '',      // ví dụ '0123456789' để chỉ nhận số
    uppercase: false,       // ép in hoa kết quả
    append: false,          // true: nối vào nội dung đang có trong ô
    buttonText: 'Quét',
    buttonClass: '',        // thêm class cho nút để khớp giao diện trang
    tesseractSrc: TESSERACT_SRC,
    langPath: '',           // thư mục chứa *.traineddata nếu muốn tự host; để trống = dùng model tốt nhất có sẵn
    debug: false,           // true: lưu khung đã xử lý vào window.__cameraOcrFrame để kiểm tra
    onResult: null          // function (text, input) gọi sau khi điền
  };

  var tesseractPromise = null;
  var worker = null;
  var workerKey = '';

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i] || {};
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function loadTesseract(src) {
    if (global.Tesseract) return Promise.resolve(global.Tesseract);
    if (!tesseractPromise) {
      tesseractPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = function () { resolve(global.Tesseract); };
        s.onerror = function () { tesseractPromise = null; reject(new Error('Không tải được Tesseract.js')); };
        document.head.appendChild(s);
      });
    }
    return tesseractPromise;
  }

  function getWorker(opts, onProgress) {
    var key = [opts.lang, opts.psm, opts.charWhitelist, opts.langPath].join('|');
    if (worker && workerKey === key) return worker;
    var old = worker;
    workerKey = key;
    worker = loadTesseract(opts.tesseractSrc).then(function (T) {
      var cfg = { logger: function (m) { if (onProgress) onProgress(m); } };
      var lp = opts.langPath || BEST_LANG_PATH[opts.lang];
      if (lp) cfg.langPath = lp;
      return T.createWorker(opts.lang, 1, cfg);
    }).then(function (w) {
      var params = {
        tessedit_pageseg_mode: String(opts.psm),
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      };
      if (opts.charWhitelist) params.tessedit_char_whitelist = opts.charWhitelist;
      return w.setParameters(params).then(function () { return w; });
    });
    if (old) old.then(function (w) { w.terminate(); }, function () {});
    worker.catch(function () { if (workerKey === key) { worker = null; workerKey = ''; } });
    return worker;
  }

  function normalize(text, opts) {
    var t = String(text || '').replace(/[​-‍﻿]/g, '');
    t = opts.multiline ? t.replace(/\s*\n+\s*/g, ' ') : t.replace(/\s*\n[\s\S]*$/, '');
    t = t.replace(/\s+/g, ' ').trim();
    if (opts.uppercase) t = t.toLocaleUpperCase('vi');
    return t;
  }

  function similarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      var t = prev; prev = cur; cur = t;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  // Chuyển xám, kéo giãn tương phản, rồi (tuỳ chọn) lọc nền bằng ngưỡng thích ứng theo vùng.
  // Trả về độ nét (phương sai Laplace) để bỏ qua khung hình bị mờ.
  function preprocess(canvas, binarize) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var w = canvas.width, h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data, n = w * h, gray = new Uint8ClampedArray(n), hist = new Array(256), i, x, y;
    for (i = 0; i < 256; i++) hist[i] = 0;
    for (i = 0; i < n; i++) {
      var g = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0;
      gray[i] = g; hist[g]++;
    }
    var lo = 0, hi = 255, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.02) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.02) { hi = i; break; } }
    var range = Math.max(hi - lo, 1);
    for (i = 0; i < n; i++) gray[i] = (gray[i] - lo) * 255 / range;

    var sum = 0, sum2 = 0, cnt = 0;
    for (y = 1; y < h - 1; y += 2) {
      for (x = 1; x < w - 1; x += 2) {
        i = y * w + x;
        var lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += lap; sum2 += lap * lap; cnt++;
      }
    }
    var sharp = cnt ? sum2 / cnt - Math.pow(sum / cnt, 2) : 0;

    var out = gray;
    if (binarize) {
      // Ảnh tích phân → trung bình cục bộ (Bradley); chữ tối hơn nền cục bộ ~12% là chữ.
      var integ = new Float64Array((w + 1) * (h + 1));
      for (y = 1; y <= h; y++) {
        var row = 0;
        for (x = 1; x <= w; x++) {
          row += gray[(y - 1) * w + x - 1];
          integ[y * (w + 1) + x] = integ[(y - 1) * (w + 1) + x] + row;
        }
      }
      var r = Math.max(8, Math.round(h / 2)), bin = new Uint8ClampedArray(n);
      for (y = 0; y < h; y++) {
        var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        for (x = 0; x < w; x++) {
          var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
          var area = (x1 - x0) * (y1 - y0);
          var s = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
          bin[y * w + x] = gray[y * w + x] * area < s * 0.88 ? 0 : 255;
        }
      }
      out = bin;
    }
    for (i = 0; i < n; i++) { var v = out[i]; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    return sharp;
  }

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.wrap{position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;flex-direction:column;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff}',
    '.top{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(0,0,0,.6)}',
    '.top b{font-size:16px}',
    '.stage{position:relative;flex:1;overflow:hidden;background:#111}',
    'video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '.box{position:absolute;left:50%;top:42%;width:88%;max-width:720px;height:80px;transform:translate(-50%,-50%);border:3px solid #22c55e;border-radius:10px;box-shadow:0 0 0 100vmax rgba(0,0,0,.55);pointer-events:none;transition:border-color .2s}',
    '.box.busy{border-color:#facc15}',
    '.hint{position:absolute;left:0;right:0;top:calc(42% - 88px);text-align:center;font-size:13px;text-shadow:0 1px 3px #000;padding:0 12px}',
    '.bottom{padding:12px 14px calc(12px + env(safe-area-inset-bottom));background:rgba(0,0,0,.75);display:flex;flex-direction:column;gap:10px}',
    '.result{min-height:42px;padding:8px 10px;border-radius:8px;background:#1f2937;font-size:17px;word-break:break-word}',
    '.result small{display:block;color:#9ca3af;font-size:12px}',
    '.row{display:flex;gap:8px}',
    'button{flex:1;padding:12px;border:0;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;color:#fff;background:#374151}',
    'button.primary{background:#16a34a}',
    'button:disabled{opacity:.45;cursor:default}',
    '.err{color:#fca5a5}'
  ].join('');

  function openScanner(options) {
    var opts = assign({}, DEFAULTS, options);
    if (opts.multiline && !(options && options.psm)) opts.psm = 6;

    return new Promise(function (resolve, reject) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return reject(new Error('Trình duyệt không hỗ trợ camera (cần HTTPS).'));
      }

      var host = document.createElement('div');
      var root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' + CSS + '</style>' +
        '<div class="wrap" role="dialog" aria-modal="true" aria-label="Quét chữ bằng camera">' +
        '<div class="top"><b>Quét chữ</b><span class="state">Đang mở camera…</span></div>' +
        '<div class="stage"><video playsinline muted autoplay></video>' +
        '<div class="hint">Đưa dòng chữ vào trong khung xanh</div><div class="box"></div></div>' +
        '<div class="bottom"><div class="result"><small>Kết quả</small><span class="text">—</span></div>' +
        '<div class="row"><button class="torch" hidden>Đèn</button><button class="flip">Đổi camera</button>' +
        '<button class="cancel">Đóng</button><button class="primary use" disabled>Dùng kết quả</button></div></div></div>';
      document.body.appendChild(host);

      var $ = function (s) { return root.querySelector(s); };
      var video = $('video'), stage = $('.stage'), box = $('.box'),
          stateEl = $('.state'), textEl = $('.text'), useBtn = $('.use'),
          torchBtn = $('.torch'), flipBtn = $('.flip');

      var stream = null, closed = false, facing = 'environment', timer = null;
      var current = '', last = '', stable = 0;
      var work = document.createElement('canvas');
      var workCtx = null, lastSharp = 0, bestSharp = 0;

      function setState(msg, isErr) {
        stateEl.textContent = msg;
        stateEl.className = 'state' + (isErr ? ' err' : '');
      }

      function finish(err, text) {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        document.removeEventListener('keydown', onKey, true);
        host.remove();
        if (err) reject(err); else resolve(text);
      }

      function onKey(e) { if (e.key === 'Escape') finish(null, null); }
      document.addEventListener('keydown', onKey, true);
      $('.cancel').onclick = function () { finish(null, null); };
      useBtn.onclick = function () { if (current) finish(null, current); };

      function startCamera() {
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        return navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        }).then(function (s) {
          if (closed) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
          stream = s;
          video.srcObject = s;
          var track = s.getVideoTracks()[0];
          var caps = track.getCapabilities ? track.getCapabilities() : {};
          torchBtn.hidden = !caps.torch;
          var adv = [];
          if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) adv.push({ focusMode: 'continuous' });
          if (adv.length) track.applyConstraints({ advanced: adv }).catch(function () {});
          return video.play();
        });
      }

      var torchOn = false;
      torchBtn.onclick = function () {
        var track = stream && stream.getVideoTracks()[0];
        if (!track) return;
        torchOn = !torchOn;
        track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () { torchOn = !torchOn; });
      };
      flipBtn.onclick = function () {
        facing = facing === 'environment' ? 'user' : 'environment';
        torchOn = false;
        startCamera().catch(function (e) { setState(e.message, true); });
      };

      // Cắt đúng vùng khung xanh từ khung hình video (video dùng object-fit: cover).
      function cropFrame() {
        var vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return null;
        var sr = stage.getBoundingClientRect(), br = box.getBoundingClientRect();
        var scale = Math.max(sr.width / vw, sr.height / vh);
        var offX = (vw * scale - sr.width) / 2, offY = (vh * scale - sr.height) / 2;
        var sx = Math.max(0, (br.left - sr.left + offX) / scale);
        // Nới thêm ~14% chiều cao khung ở trên/dưới để dấu (ễ, ặ, ...) lệch ra mép khung không bị cắt.
        var ext = br.height * 0.14;
        var sy = Math.max(0, (br.top - ext - sr.top + offY) / scale);
        var sw = Math.min(vw - sx, br.width / scale);
        var sh = Math.min(vh - sy, (br.height + ext * 2) / scale);
        if (sw < 8 || sh < 8) return null;
        var up = Math.min(3, Math.max(1, 1200 / sw));   // phóng to vùng nhỏ cho dấu rõ hơn
        var pad = 12;                                    // viền trắng quanh chữ giúp Tesseract đọc ổn định
        work.width = Math.round(sw * up) + pad * 2;
        work.height = Math.round(sh * up) + pad * 2;
        workCtx = workCtx || work.getContext('2d', { willReadFrequently: true });
        workCtx.fillStyle = '#fff';
        workCtx.fillRect(0, 0, work.width, work.height);
        workCtx.imageSmoothingQuality = 'high';
        workCtx.drawImage(video, sx, sy, sw, sh, pad, pad, work.width - pad * 2, work.height - pad * 2);
        lastSharp = preprocess(work, opts.binarize);
        if (opts.debug) global.__cameraOcrFrame = work;
        return work;
      }

      function loop(w) {
        if (closed) return;
        var frame = video.readyState >= 2 ? cropFrame() : null;
        if (!frame) { timer = setTimeout(function () { loop(w); }, 200); return; }
        bestSharp = Math.max(bestSharp * 0.97, lastSharp);
        if (lastSharp < bestSharp * 0.5) {   // khung đang mờ (rung tay, chưa lấy nét): bỏ qua
          setState('Giữ máy chắc tay, chờ lấy nét…');
          timer = setTimeout(function () { loop(w); }, 120);
          return;
        }
        setState('Đang quét…');
        box.classList.add('busy');
        w.recognize(frame).then(function (res) {
          if (closed) return;
          box.classList.remove('busy');
          var text = normalize(res.data.text, opts);
          var conf = res.data.confidence || 0;
          var ws = (res.data.words || []).filter(function (x) { return x.text && x.text.trim(); });
          if (ws.length) conf = ws.reduce(function (a, x) { return a + x.confidence; }, 0) / ws.length;
          if (text.length >= 2) {
            current = text;
            useBtn.disabled = false;
            textEl.textContent = text;
            textEl.parentNode.firstChild.textContent = 'Độ tin cậy ' + Math.round(conf) + '%';
            if (conf >= opts.minConfidence) {
              stable = similarity(text.toLowerCase(), last.toLowerCase()) >= 0.9 ? stable + 1 : 1;
              last = text;
              if (stable >= opts.stableReads) return finish(null, text);
            } else { stable = 0; last = ''; }
          } else { stable = 0; last = ''; }
          timer = setTimeout(function () { loop(w); }, opts.intervalMs);
        }).catch(function (e) { finish(e); });
      }

      startCamera().then(function () {
        if (closed) return;
        setState('Đang tải bộ nhận diện…');
        return getWorker(opts, function (m) {
          if (!closed && m.status && m.status !== 'recognizing text' && m.progress != null) {
            setState('Đang tải dữ liệu ' + Math.round(m.progress * 100) + '%');
          }
        });
      }).then(function (w) {
        if (closed || !w) return;
        setState('Đang quét…');
        loop(w);
      }).catch(function (e) {
        var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        finish(new Error(denied ? 'Bạn chưa cho phép dùng camera.' : (e && e.message) || 'Không mở được camera.'));
      });
    });
  }

  function attach(input, options) {
    if (!input || input.__cameraOcr) return;
    input.__cameraOcr = true;
    var opts = assign({}, DEFAULTS, options);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = opts.buttonText;
    btn.className = opts.buttonClass;
    btn.setAttribute('aria-label', 'Quét chữ bằng camera');
    if (!opts.buttonClass) {
      btn.style.cssText = 'margin-left:6px;padding:6px 12px;border:1px solid #16a34a;border-radius:6px;background:#16a34a;color:#fff;font:inherit;cursor:pointer';
    }
    input.insertAdjacentElement('afterend', btn);

    btn.addEventListener('click', function () {
      btn.disabled = true;
      openScanner(opts).then(function (text) {
        if (!text) return;
        input.value = opts.append && input.value ? input.value + ' ' + text : text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus();
        if (typeof opts.onResult === 'function') opts.onResult(text, input);
      }).catch(function (e) {
        alert(e.message || 'Không quét được.');
      }).then(function () { btn.disabled = false; });
    });
    return btn;
  }

  // Đọc cấu hình từ thuộc tính data-*: data-lang, data-psm, data-multiline, data-uppercase,
  // data-whitelist, data-min-confidence, data-button-text.
  function fromDataset(el) {
    var d = el.dataset, o = {};
    if (d.lang) o.lang = d.lang;
    if (d.psm) o.psm = +d.psm;
    if (d.multiline != null) o.multiline = d.multiline !== 'false';
    if (d.uppercase != null) o.uppercase = d.uppercase !== 'false';
    if (d.append != null) o.append = d.append !== 'false';
    if (d.whitelist) o.charWhitelist = d.whitelist;
    if (d.minConfidence) o.minConfidence = +d.minConfidence;
    if (d.buttonText) o.buttonText = d.buttonText;
    if (d.langPath) o.langPath = d.langPath;
    if (d.debug != null) o.debug = d.debug !== 'false';
    if (d.binarize != null) o.binarize = d.binarize !== 'false';
    return o;
  }

  function autoAttach(rootEl) {
    var list = (rootEl || document).querySelectorAll('input[data-camera-ocr], textarea[data-camera-ocr]');
    for (var i = 0; i < list.length; i++) attach(list[i], fromDataset(list[i]));
  }

  global.CameraOCR = {
    attach: attach,
    scan: openScanner,
    autoAttach: autoAttach,
    defaults: DEFAULTS
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { autoAttach(); });
  else autoAttach();
})(window);
