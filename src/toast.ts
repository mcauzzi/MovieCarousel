let toastEl: HTMLElement;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export function initToast(): void {
  toastEl = document.createElement('div');
  toastEl.id = 'toast';
  document.body.appendChild(toastEl);
}

export function showToast(message: string, type: 'info' | 'success' | 'warn' = 'info'): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  toastEl.textContent = message;
  toastEl.dataset.type = type;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  dismissTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    dismissTimer = null;
  }, 2500);
}
