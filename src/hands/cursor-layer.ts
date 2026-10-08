/**
 * Wired Future — on-screen cursors for webcam hands.
 *
 * A hand cannot be aimed without seeing where it points, so each tracked hand
 * gets a ring on the screen. It shrinks as the fingers close, so the pinch is
 * previewed before it lands, and fills in while something is held.
 *
 * Plain DOM, owned by the hand controller rather than React: the camera
 * delivers about 30 positions a second, and routing them through React state
 * would re-render on every one. Positions are eased towards on every DISPLAY
 * frame, so a 30 fps camera still draws a 60 fps cursor. Labels come from
 * asset mesh names, so text is always set with textContent.
 */

export type CursorMode = 'point' | 'aim' | 'hold' | 'lost';

export interface CursorView {
  /** Viewport pixels. */
  x: number;
  y: number;
  mode: CursorMode;
  /** 0..1: how far the pinch has closed, while aiming. */
  progress: number;
  /** What the hand points at or holds; empty hides the label. */
  name: string;
  hint: string;
}

interface CursorItem {
  el: HTMLDivElement;
  nameEl: HTMLSpanElement;
  hintEl: HTMLSpanElement;
  targetX: number;
  targetY: number;
  x: number;
  y: number;
  placed: boolean;
  shown: boolean;
  mode: CursorMode | '';
  name: string;
  hint: string;
  progress: number;
}

/** Per-second rate the drawn cursor closes on the tracked position. */
const FOLLOW_RATE = 40;

export class HandCursorLayer {
  private readonly root: HTMLDivElement;
  private readonly items: CursorItem[] = [];
  private raf = 0;
  private lastFrame = 0;
  private disposed = false;

  constructor(parent: HTMLElement, count = 2) {
    this.root = document.createElement('div');
    this.root.className = 'wf-handlayer';
    // Pointer-only feedback: the panel's status line says the same in words.
    this.root.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < count; i += 1) {
      const el = document.createElement('div');
      el.className = 'wf-handcursor';
      el.dataset.hand = String(i);
      const ring = document.createElement('span');
      ring.className = 'wf-handcursor__ring';
      const dot = document.createElement('span');
      dot.className = 'wf-handcursor__dot';
      const label = document.createElement('span');
      label.className = 'wf-handcursor__label';
      const nameEl = document.createElement('span');
      nameEl.className = 'wf-handcursor__name';
      const hintEl = document.createElement('span');
      hintEl.className = 'wf-handcursor__hint';
      label.append(nameEl, hintEl);
      el.append(ring, dot, label);
      this.root.appendChild(el);
      this.items.push({
        el,
        nameEl,
        hintEl,
        targetX: 0,
        targetY: 0,
        x: 0,
        y: 0,
        placed: false,
        shown: false,
        mode: '',
        name: '',
        hint: '',
        progress: -1,
      });
    }
    parent.appendChild(this.root);
  }

  /** Update one hand's cursor; null hides it. */
  set(slot: number, view: CursorView | null): void {
    const item = this.items[slot];
    if (!item || this.disposed) return;

    if (!view) {
      if (item.shown) {
        item.shown = false;
        item.placed = false;
        item.el.classList.remove('is-visible');
      }
      return;
    }

    item.targetX = view.x;
    item.targetY = view.y;
    if (!item.placed) {
      // A hand that just appeared is drawn where it is, not eased in from
      // wherever the last one left.
      item.x = view.x;
      item.y = view.y;
      item.placed = true;
      this.place(item);
    }
    if (!item.shown) {
      item.shown = true;
      item.el.classList.add('is-visible');
    }
    if (view.mode !== item.mode) {
      item.mode = view.mode;
      item.el.dataset.mode = view.mode;
    }
    const progress = Math.round(Math.max(0, Math.min(1, view.progress)) * 100) / 100;
    if (progress !== item.progress) {
      item.progress = progress;
      item.el.style.setProperty('--wf-hc-p', String(progress));
    }
    if (view.name !== item.name) {
      item.name = view.name;
      item.nameEl.textContent = view.name;
      item.el.classList.toggle('has-label', view.name.length > 0);
    }
    if (view.hint !== item.hint) {
      item.hint = view.hint;
      item.hintEl.textContent = view.hint;
    }
    this.kick();
  }

  clear(): void {
    for (let i = 0; i < this.items.length; i += 1) this.set(i, null);
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.root.remove();
  }

  private place(item: CursorItem): void {
    item.el.style.transform =
      'translate3d(' + item.x.toFixed(1) + 'px,' + item.y.toFixed(1) + 'px,0)';
    // Near the right edge the label goes on the left of the ring instead.
    const flip = typeof window !== 'undefined' && item.x > window.innerWidth - 280;
    if (flip !== item.el.classList.contains('is-flipped')) {
      item.el.classList.toggle('is-flipped', flip);
    }
  }

  private kick(): void {
    if (this.raf || this.disposed) return;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.step);
  }

  private step = (now: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const k = 1 - Math.exp(-dt * FOLLOW_RATE);
    let moving = false;
    for (const item of this.items) {
      if (!item.shown) continue;
      const dx = item.targetX - item.x;
      const dy = item.targetY - item.y;
      if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) {
        if (dx !== 0 || dy !== 0) {
          item.x = item.targetX;
          item.y = item.targetY;
          this.place(item);
        }
        continue;
      }
      item.x += dx * k;
      item.y += dy * k;
      this.place(item);
      moving = true;
    }
    if (moving) this.raf = requestAnimationFrame(this.step);
  };
}
