export interface ModalPage {
  readonly current: boolean;
  dismiss(): void;
  action(callback: () => void): () => void;
}

/** Own each rendered dialog so queued clicks cannot act on its replacement. */
export function createModalNavigation(rawClose: () => void) {
  let current: ModalPage | undefined;
  let revision = 0;
  const clear = () => { revision++; current = undefined; };
  return {
    clear,
    dismiss: () => current?.dismiss(),
    open(onDismiss?: () => void): ModalPage {
      const page: ModalPage = {
        get current() { return current === page; },
        dismiss() {
          if (current !== page) return;
          clear(); (onDismiss ?? rawClose)();
        },
        action(callback) {
          return () => {
            if (current !== page) return;
            const before = revision; current = undefined;
            try { callback(); }
            finally {
              // A failed synchronous commit leaves its dialog open and must remain retryable.
              if (revision === before) current = page;
            }
          };
        },
      };
      revision++; current = page; return page;
    },
  };
}
