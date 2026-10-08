/**
 * Wired Future — DOM chrome that belongs to the canvas.
 *
 * The pointer tag follows the mouse at pointer-move rate. Routed through React
 * state it would re-render on every move; as a plain element the engine owns,
 * it costs one style write. Text comes from asset mesh names, so it is always
 * set with textContent, never innerHTML.
 */

export class HoverTag {
  private readonly el: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly hintEl: HTMLSpanElement;
  private shown = false;
  private name = '';
  private hint = '';
  private width = 0;
  private height = 0;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'wf-hovertag';
    // Pointer-only information about what is under the mouse; the same parts
    // are reachable by name in the Parts list for everyone else.
    this.el.setAttribute('aria-hidden', 'true');
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'wf-hovertag__name';
    this.hintEl = document.createElement('span');
    this.hintEl.className = 'wf-hovertag__hint';
    this.el.append(this.nameEl, this.hintEl);
    container.appendChild(this.el);
  }

  set(name: string, hint: string): void {
    if (name !== this.name) {
      this.name = name;
      this.nameEl.textContent = name;
      this.width = 0;
    }
    if (hint !== this.hint) {
      this.hint = hint;
      this.hintEl.textContent = hint;
      this.hintEl.hidden = hint.length === 0;
      this.width = 0;
    }
  }

  /** Viewport coordinates of the pointer. Flips away from the edges. */
  moveTo(x: number, y: number): void {
    if (!this.width) {
      this.width = this.el.offsetWidth;
      this.height = this.el.offsetHeight;
    }
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
    let left = x + 18;
    let top = y + 20;
    if (vw && left + this.width > vw - 8) left = x - this.width - 14;
    if (vh && top + this.height > vh - 8) top = y - this.height - 14;
    this.el.style.transform =
      'translate3d(' + Math.round(left) + 'px,' + Math.round(top) + 'px,0)';
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.el.classList.add('is-visible');
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.el.classList.remove('is-visible');
  }

  dispose(): void {
    this.el.remove();
  }
}

/** Small status capsule for slow background work, e.g. the car streaming in. */
export class StatusPill {
  private readonly el: HTMLDivElement;
  private readonly textEl: HTMLSpanElement;
  private readonly barEl: HTMLSpanElement;
  private hideTimer = 0;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'wf-statuspill';
    // Loading and its outcome are worth announcing, politely.
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.textEl = document.createElement('span');
    this.textEl.className = 'wf-statuspill__text';
    const track = document.createElement('span');
    track.className = 'wf-statuspill__track';
    this.barEl = document.createElement('span');
    this.barEl.className = 'wf-statuspill__bar';
    track.appendChild(this.barEl);
    this.el.append(this.textEl, track);
    container.appendChild(this.el);
  }

  /** `progress` 0..1, or a negative number when the total is unknown. */
  show(text: string, progress: number): void {
    window.clearTimeout(this.hideTimer);
    this.textEl.textContent = text;
    this.setProgress(progress);
    this.el.classList.remove('is-done', 'is-failed');
    this.el.classList.add('is-visible');
  }

  setProgress(progress: number): void {
    const known = progress >= 0;
    this.el.classList.toggle('is-indeterminate', !known);
    this.barEl.style.transform = 'scaleX(' + (known ? Math.max(0.02, progress) : 1) + ')';
  }

  done(text: string): void {
    this.textEl.textContent = text;
    this.setProgress(1);
    this.el.classList.add('is-done');
    this.hideAfter(1100);
  }

  fail(text: string): void {
    this.textEl.textContent = text;
    this.el.classList.add('is-failed');
    this.hideAfter(4200);
  }

  hide(): void {
    window.clearTimeout(this.hideTimer);
    this.el.classList.remove('is-visible');
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer);
    this.el.remove();
  }

  private hideAfter(ms: number): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.el.classList.remove('is-visible'), ms);
  }
}
