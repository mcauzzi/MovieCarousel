let overlay: HTMLElement;

function waitForAnimation(el: HTMLElement): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => {
      el.removeEventListener('animationend', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 500);
    el.addEventListener('animationend', done, { once: true });
  });
}

export function initTransitions(): void {
  overlay = document.createElement('div');
  overlay.id = 'transition-overlay';
  document.body.appendChild(overlay);
  document.body.classList.add('transitions-enabled');
}

// Catena di transizioni: ogni chiamata attende il completamento della
// precedente, così due click ravvicinati non si sovrappongono sullo stesso
// overlay (niente classi t-enter/t-exit stompate a metà animazione) e l'ultimo
// callback vince sempre. Un .catch resetta la catena se un callback lancia.
let chain: Promise<void> = Promise.resolve();

export function withTransition(callback: () => void): Promise<void> {
  if (!document.body.classList.contains('transitions-enabled')) {
    callback();
    return Promise.resolve();
  }
  const run = chain.catch(() => {}).then(async () => {
    overlay.classList.add('t-enter');
    await waitForAnimation(overlay);
    overlay.classList.remove('t-enter');
    callback();
    overlay.classList.add('t-exit');
    await waitForAnimation(overlay);
    overlay.classList.remove('t-exit');
  });
  chain = run;
  return run;
}
