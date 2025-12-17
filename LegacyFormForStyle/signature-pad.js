/**
 * Lightweight Signature Pad — fixed version
 */
class SignaturePad {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    this.options = {
      penColor:        '#000000',
      backgroundColor: '#ffffff',
      minWidth:        1,
      maxWidth:        3,
      throttle:        16,
      ...options
    };

    this.isDrawing    = false;
    this.points       = [];
    this._lastVelocity = 0;
    this._lastWidth    = (this.options.minWidth + this.options.maxWidth) / 2;

    this.init();
  }

  /* ---------- lifecycle ---------- */

  init() {
    this.handleResize();
    this.clear();
    this.bindEvents();
  }

  bindEvents() {
    /* Mouse */
    this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
    this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
    ['mouseup', 'mouseleave'].forEach(e =>
      this.canvas.addEventListener(e, this.handleMouseUp.bind(this)));

    /* Touch */
    this.canvas.addEventListener('touchstart', this.handleTouchStart.bind(this));
    this.canvas.addEventListener('touchmove',  this.handleTouchMove.bind(this));
    this.canvas.addEventListener('touchend',   this.handleTouchEnd.bind(this));

    /* Prevent scroll */
    ['touchstart', 'touchmove'].forEach(e =>
      this.canvas.addEventListener(e, ev => ev.preventDefault(), { passive:false }));

    /* Resize */
    window.addEventListener('resize', this.handleResize.bind(this));
  }

  handleResize() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);        // reset
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width  = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.scale(dpr, dpr);

    this.redraw();
  }

  /* ---------- event helpers ---------- */

  _evtPoint(ev, touch = false) {
    const { left, top } = this.canvas.getBoundingClientRect();
    return {
      x: (touch ? ev.clientX : ev.clientX) - left,
      y: (touch ? ev.clientY : ev.clientY) - top,
      time: Date.now()
    };
  }

  /* Mouse */
  handleMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this._startStroke(this._evtPoint(e));
  }
  handleMouseMove(e) {
    if (!this.isDrawing) return;
    e.preventDefault();
    this._addPoint(this._evtPoint(e));
  }
  handleMouseUp() { this._endStroke(); }

  /* Touch */
  handleTouchStart(e) {
    this._startStroke(this._evtPoint(e.touches[0], true));
  }
  handleTouchMove(e) {
    if (!this.isDrawing) return;
    this._addPoint(this._evtPoint(e.touches[0], true));
  }
  handleTouchEnd() { this._endStroke(); }

  /* ---------- stroke logic ---------- */

  _startStroke(p) {
    this.isDrawing = true;
    this.points.length = 0;
    this._reset();
    this._addPoint(p);
  }
  _endStroke() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.canvas.dispatchEvent(new Event('end'));
  }

  _addPoint(p) {
    this.points.push(p);

    if (this.points.length > 2) {
      if (this.points.length === 3) this.points.unshift(this.points[0]);

      const [p0, p1, p2] = this.points.slice(-3);
      const cp1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      /* draw quadratic curve */
      this._drawCurve(cp1, p2);

      this.points.shift();            // keep last two points
    } else if (this.points.length === 1) {
      this._drawDot(p);
    }
  }

  _drawDot(p) {
    this.ctx.beginPath();
    this.ctx.fillStyle = this.options.penColor;
    this.ctx.arc(p.x, p.y, this._lastWidth / 2, 0, Math.PI * 2);
    this.ctx.fill();
  }

  _drawCurve(cp, end) {
    const v   = this._velocity(this.points[this.points.length-2], end);
    const w   = this._calculateWidth(v);

    this.ctx.beginPath();
    this.ctx.lineWidth = this._lastWidth;
    this.ctx.moveTo(cp.x, cp.y);
    this.ctx.quadraticCurveTo(cp.x, cp.y, end.x, end.y);
    this.ctx.stroke();
    this._lastWidth = w;
  }

  _velocity(a, b) {
    const dt = b.time - a.time;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return dt ? Math.sqrt(dx*dx + dy*dy) / dt : 0;
  }
  _calculateWidth(v) {
    const range = this.options.maxWidth - this.options.minWidth;
    const w = this.options.maxWidth - v * range;
    return Math.max(this.options.minWidth,
                    Math.min(this.options.maxWidth, w));
  }

  /* ---------- public API ---------- */

  clear() {
    this.ctx.fillStyle = this.options.backgroundColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.points.length = 0;
    this._reset();
  }
  isEmpty() { return !this.points.length; }
  toDataURL(type='image/png', q=1) { return this.canvas.toDataURL(type, q); }
  fromDataURL(dataURL) {
    const img = new Image();
    const dpr = window.devicePixelRatio || 1;
    img.onload = () => {
      this.clear();
      this.ctx.drawImage(img, 0, 0,
        this.canvas.width  / dpr,
        this.canvas.height / dpr);
    };
    img.src = dataURL;
  }
  redraw() {
    const data = this.toDataURL();
    this.clear();
    this.fromDataURL(data);
  }
  on(evt, cb)  { this.canvas.addEventListener(evt, cb); }
  off(evt, cb) { this.canvas.removeEventListener(evt, cb); }

  /* ---------- private ---------- */

  _reset() {
    this._lastVelocity = 0;
    this._lastWidth    = (this.options.minWidth + this.options.maxWidth) / 2;
    this.ctx.lineCap   = 'round';
    this.ctx.lineJoin  = 'round';
    this.ctx.strokeStyle = this.options.penColor;
  }
}

window.SignaturePad = SignaturePad;