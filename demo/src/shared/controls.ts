// A tiny fixed control panel some examples use for buttons and a status line. It is plain DOM with no
// ViewLeader knowledge; pages own what each button does.

/**
 * A choice the user reads paired with the id the page acts on.
 *
 * A bare string is both, which is why it is still accepted: `dogleg` and `paper` are domain words a
 * reader understands as they stand, and forcing `{ value: 'dogleg', label: 'dogleg' }` on the pages
 * that list them would be noise. Ids a human should never see — `builtin.style.tag-hexagon` — take
 * the object form and show their definition's `name` instead.
 */
export type SelectOption = string | { readonly value: string; readonly label: string };

export interface ControlSelect {
  readonly element: HTMLSelectElement;
  /**
   * Pushes live state into the box WITHOUT firing `onChange`.
   *
   * That is the whole point of it. A page re-syncing a box from the document it just changed would
   * otherwise re-enter the handler that made the change — assigning `.value` never fires `change`,
   * so the loop cannot start. A value that is not one of the options leaves the box blank rather
   * than picking something the caller did not ask for.
   */
  set(value: string): void;
  /** Rebuilds the list, keeping the current value selected if it is still one of the options. */
  options(next: readonly SelectOption[]): void;
}

export interface ControlBar {
  readonly element: HTMLElement;
  button(label: string, action: () => void | Promise<void>): HTMLButtonElement;
  select(
    label: string,
    options: readonly SelectOption[],
    onChange: (value: string) => void,
  ): ControlSelect;
  status(text: string): void;
}

const parts = (option: SelectOption): { value: string; label: string } =>
  typeof option === 'string' ? { value: option, label: option } : option;

export function createControlBar(): ControlBar {
  // One dock, status stacked above the bar. Separately positioned elements would overlap as soon as
  // a page had enough controls to wrap the bar onto a second row.
  const dock = document.createElement('div');
  dock.className = 'control-dock';
  const output = document.createElement('output');
  output.className = 'control-status';
  const element = document.createElement('div');
  element.className = 'control-bar';
  dock.append(output, element);
  document.body.append(dock);

  return {
    element,
    button(label, action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        void Promise.resolve(action()).catch((error: unknown) => {
          output.textContent = error instanceof Error ? error.message : String(error);
        });
      });
      element.append(button);
      return button;
    },
    select(label, options, onChange) {
      // The caption is rendered, not just announced. `aria-label` alone left a sighted reader with
      // `dogleg`, `leg-1` and `Tag · circle` side by side as three naked boxes and nothing saying
      // which was which. Wrapping in a `<label>` is also the association — no `for`/`id` pair to
      // keep unique across a page that builds a dozen of these.
      const wrapper = document.createElement('label');
      wrapper.className = 'control-select';
      const caption = document.createElement('span');
      caption.textContent = label;
      const select = document.createElement('select');
      const control: ControlSelect = {
        element: select,
        set(value) {
          select.value = value;
        },
        options(next) {
          const previous = select.value;
          select.replaceChildren();
          for (const option of next) {
            const { value, label: text } = parts(option);
            select.add(new Option(text, value));
          }
          // Ask the DOM whether the old value survived rather than searching the list twice: a value
          // with no matching option lands on `selectedIndex === -1`, which renders as a blank box.
          select.value = previous;
          if (select.selectedIndex < 0) select.selectedIndex = 0;
        },
      };
      control.options(options);
      select.addEventListener('change', () => onChange(select.value));
      wrapper.append(caption, select);
      element.append(wrapper);
      return control;
    },
    status(text) {
      output.textContent = text;
    },
  };
}
