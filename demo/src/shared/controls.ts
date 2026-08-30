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

/**
 * The `<label>`-wrapped select both the bar and the side panel use.
 *
 * Shared rather than written twice because the caption rule is graded: the e2e suite asserts that
 * every select shows a rendered caption and that no raw `builtin.` id ever reaches option text. A
 * second copy of this is a second place for that to regress.
 */
function buildSelect(
  parent: HTMLElement,
  label: string,
  options: readonly SelectOption[],
  onChange: (value: string) => void,
): ControlSelect {
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
  parent.append(wrapper);
  return control;
}

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
      return buildSelect(element, label, options, onChange);
    },
    status(text) {
      output.textContent = text;
    },
  };
}

/* --- Side panel --------------------------------------------------------------------------------
 *
 * The bar docks a handful of controls along the bottom. A page that edits every field of a style
 * needs twenty of them grouped under headings, which is a panel, not a bar. Same rule as the bar:
 * plain DOM, no ViewLeader knowledge, pages own what each control does.
 */

/** One control whose value the page pushes back in from the document. */
export interface PanelField<Value> {
  readonly element: HTMLElement;
  /**
   * Pushes live state into the control WITHOUT firing its handler, exactly like
   * {@link ControlSelect.set}. `undefined` means "the document does not set this", which renders as
   * the control's resting state rather than as a value the page never chose.
   */
  set(value: Value | undefined): void;
  disabled(value: boolean): void;
  /** Marks the control as carrying an explicit override rather than an inherited value. */
  overridden(value: boolean): void;
}

/**
 * Continuous controls report whether the change is still part of one gesture.
 *
 * A colour picker and a slider both fire `input` on every step of a drag. Committing each step as
 * its own undo entry turns one drag into fifty of them, so the page passes `continuing` straight
 * through to `history.transaction`'s `coalesce` and the whole drag lands as one step. The control
 * cannot decide that itself — `coalesce` merges by label, which is the page's word, not this file's.
 */
export type ContinuousChange<Value> = (value: Value, continuing: boolean) => void;

export interface PanelSection {
  readonly element: HTMLElement;
  button(label: string, action: () => void | Promise<void>): HTMLButtonElement;
  select(
    label: string,
    options: readonly SelectOption[],
    onChange: (value: string) => void,
  ): ControlSelect;
  color(label: string, onChange: ContinuousChange<string>): PanelField<string>;
  range(
    label: string,
    bounds: { readonly min: number; readonly max: number; readonly step: number },
    onChange: ContinuousChange<number>,
  ): PanelField<number>;
}

export interface SidePanel {
  readonly element: HTMLElement;
  /** A titled group. Called twice with the same title, it returns the same group. */
  section(title: string): PanelSection;
  status(text: string): void;
}

/** A row of buttons inside a section, so tools wrap as a group instead of one per line. */
function buttonRow(parent: HTMLElement): HTMLElement {
  const row = parent.querySelector<HTMLElement>(':scope > .panel-buttons');
  if (row !== null) return row;
  const created = document.createElement('div');
  created.className = 'panel-buttons';
  parent.append(created);
  return created;
}

function createSection(panel: HTMLElement, title: string): PanelSection {
  const element = document.createElement('section');
  element.className = 'panel-section';
  const heading = document.createElement('h2');
  heading.textContent = title;
  element.append(heading);
  panel.append(element);

  /**
   * Wraps one input in its caption and returns the shared `PanelField` behaviour.
   *
   * `set` assigns `.value` directly, which never fires `input` or `change` — the same property that
   * makes re-syncing a panel from the document it just changed safe.
   */
  const field = <Value>(
    label: string,
    input: HTMLInputElement,
    read: () => Value,
    write: (value: Value) => void,
    onChange: ContinuousChange<Value>,
  ): PanelField<Value> => {
    const wrapper = document.createElement('label');
    wrapper.className = 'panel-field';
    const caption = document.createElement('span');
    caption.className = 'panel-caption';
    caption.textContent = label;
    wrapper.append(caption, input);
    element.append(wrapper);

    // True from the second `input` of a drag until the browser commits with `change`. The first
    // event of a gesture opens a fresh undo entry; the rest merge into it.
    let gesturing = false;
    input.addEventListener('input', () => {
      onChange(read(), gesturing);
      gesturing = true;
    });
    input.addEventListener('change', () => {
      gesturing = false;
    });

    return {
      element: wrapper,
      set(value) {
        if (value !== undefined) write(value);
        gesturing = false;
      },
      disabled(value) {
        input.disabled = value;
      },
      overridden(value) {
        wrapper.classList.toggle('is-overridden', value);
      },
    };
  };

  return {
    element,
    button(label, action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        void Promise.resolve(action()).catch((error: unknown) => {
          // Reported where the page reports everything else. Swallowing it here would leave a tool
          // that silently did nothing; `console.error` would fail the e2e suite for an ordinary
          // outcome like a pick that missed the model.
          panel.dispatchEvent(new CustomEvent('panel-error', {
            bubbles: true,
            detail: error instanceof Error ? error.message : String(error),
          }));
        });
      });
      buttonRow(element).append(button);
      return button;
    },
    select(label, options, onChange) {
      return buildSelect(element, label, options, onChange);
    },
    color(label, onChange) {
      const input = document.createElement('input');
      input.type = 'color';
      return field(label, input, () => input.value, (value) => { input.value = value; }, onChange);
    },
    range(label, bounds, onChange) {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(bounds.min);
      input.max = String(bounds.max);
      input.step = String(bounds.step);
      const readout = document.createElement('output');
      readout.className = 'panel-readout';
      const control = field(
        label,
        input,
        () => Number(input.value),
        (value) => { input.value = String(value); readout.textContent = input.value; },
        (value, continuing) => {
          readout.textContent = String(value);
          onChange(value, continuing);
        },
      );
      control.element.append(readout);
      return control;
    },
  };
}

export function createSidePanel(options: { title: string }): SidePanel {
  const element = document.createElement('aside');
  element.className = 'side-panel';
  const heading = document.createElement('h1');
  heading.textContent = options.title;
  const output = document.createElement('output');
  output.className = 'panel-status';
  element.append(heading, output);
  document.body.append(element);

  const sections = new Map<string, PanelSection>();
  element.addEventListener('panel-error', (event) => {
    output.textContent = (event as CustomEvent<string>).detail;
  });

  return {
    element,
    section(title) {
      const existing = sections.get(title);
      if (existing !== undefined) return existing;
      const created = createSection(element, title);
      sections.set(title, created);
      return created;
    },
    status(text) {
      output.textContent = text;
    },
  };
}
