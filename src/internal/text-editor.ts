// The framework-agnostic half of the inline label text editor: which field a double-click opens,
// what Enter and Escape mean, and what gets written back.
//
// It ships as core rather than as two components because the interesting parts are not markup.
// `AnnotationContent` is a seven-field union across five kinds, `callout.title` is the one field
// where empty and absent differ, and a referenced tag draws a string that is not the one it stores.
// A binding that re-derived any of that would be a second opinion, and the two hand-rolled demo
// editors already disagree with each other about half of it.
//
// The box, its size and its font come from the follow registry (`--vl-font-size` and friends), so
// nothing here reads geometry.
import type { SnapshotSource } from './lifecycle.js';
import { revisionCache } from './snapshot-cache.js';
import type { FollowOptions, FollowTarget } from './follow.js';
import type {
  Annotation,
  AnnotationContent,
  AnnotationPatch,
  TextDirection,
  Vec2,
} from '../types.js';

/** Every field in the union that is drawn as text. Seven of them, across five kinds. */
export type EditableTextField = 'text' | 'title' | 'primary' | 'secondary' | 'label';

export type TextEditorCloseReason = 'commit' | 'cancel' | 'gone';

/**
 * Per kind: the field a bare double-click opens, and the one field — if any — where Enter inserts
 * a newline instead of committing.
 *
 * Absent kinds carry no drawn text. `host-image.alt` is never drawn — it becomes `accessibleText`
 * only — and plugin `data` is opaque JSON core is documented never to read inside. Both need
 * `initialValue` + `onCommit`.
 *
 * Multiline is a property of the field, not a setting: a note, a callout body and a split
 * callout's second line are prose, while a tag, a grid bubble's label and a callout's title are
 * marks and headings. A grid bubble with two lines is not a grid bubble. Newlines are real either
 * way — `wrapText` splits on `\n` before wrapping — which is why the element is a textarea and not
 * an input.
 */
const TEXT_FIELDS: Partial<Record<
  AnnotationContent['kind'],
  { readonly primary: EditableTextField; readonly multiline?: EditableTextField }
>> = {
  'plain-note': { primary: 'text', multiline: 'text' },
  tag: { primary: 'text' },
  callout: { primary: 'text', multiline: 'text' },
  'split-callout': { primary: 'primary', multiline: 'secondary' },
  'symbolic-block': { primary: 'label' },
};

/** The field a bare double-click opens, or `undefined` when the kind carries no drawn text. */
export function primaryTextField(content: AnnotationContent): EditableTextField | undefined {
  return TEXT_FIELDS[content.kind]?.primary;
}

/** Whether Enter should insert a newline instead of committing. */
export function isMultilineField(content: AnnotationContent, field: EditableTextField): boolean {
  return TEXT_FIELDS[content.kind]?.multiline === field;
}

/** The stored string, or `undefined` when this kind has no such field — the caller then refuses. */
export function readTextField(
  content: AnnotationContent,
  field?: EditableTextField,
): string | undefined {
  const resolved = field ?? primaryTextField(content);
  if (resolved === undefined) return undefined;
  switch (content.kind) {
    case 'plain-note':
    case 'tag': return resolved === 'text' ? content.text : undefined;
    case 'callout':
      if (resolved === 'text') return content.text;
      // Absent opens as empty. It is the only field in the union where empty and absent differ,
      // and an author reaching for the title of a callout that has none wants a blank box.
      return resolved === 'title' ? content.title ?? '' : undefined;
    case 'split-callout':
      if (resolved === 'primary') return content.primary;
      return resolved === 'secondary' ? content.secondary : undefined;
    case 'symbolic-block': return resolved === 'label' ? content.label : undefined;
    default: return undefined;
  }
}

/**
 * The content with one field replaced, or `undefined` when this kind has no such field.
 *
 * Spelled out per kind rather than as a computed key: the three kinds the demos handle happen to
 * spell the field `text`, so `{ ...content, [field]: value }` reads as if it works and stops
 * type-checking the moment a fourth kind joins.
 */
export function writeTextField(
  content: AnnotationContent,
  field: EditableTextField,
  value: string,
): AnnotationContent | undefined {
  switch (content.kind) {
    case 'plain-note':
    case 'tag': return field === 'text' ? { ...content, text: value } : undefined;
    case 'callout': {
      if (field === 'text') return { ...content, text: value };
      if (field !== 'title') return undefined;
      // Committing an optional field empty drops it. Storing `''` would lay out as a real blank
      // first line — `wrapText('')` is `['']` — and read back as an accessible name of ": body".
      const { title: _cleared, ...rest } = content;
      return value === '' ? rest : { ...rest, title: value };
    }
    case 'split-callout':
      if (field === 'primary') return { ...content, primary: value };
      return field === 'secondary' ? { ...content, secondary: value } : undefined;
    case 'symbolic-block': return field === 'label' ? { ...content, label: value } : undefined;
    default: return undefined;
  }
}

/** What the editor needs from a `ViewLeader`. Narrow so a test can hand it a stub. */
export interface TextEditorHost {
  readonly annotations: {
    get(id: string): Annotation | undefined;
    update(id: string, patch: AnnotationPatch): unknown;
    subscribe(listener: () => void): () => void;
  };
  readonly authoring: { getSnapshot(): { readonly phase: string } };
  readonly editing: {
    hitTestScreen(at: Vec2): { readonly kind: string; readonly id: string } | undefined;
  };
}

/** The one thing the editor asks of the follow registry. `FollowRegistry` satisfies it as-is. */
export interface TextEditorFollow {
  register(target: FollowTarget, element: Element, options?: FollowOptions): () => void;
}

export interface TextEditorOptions {
  readonly host: TextEditorHost;
  /** Optional: without it the field still works, it just does not track the label. */
  readonly follow?: TextEditorFollow;
  readonly onClose?: (reason: TextEditorCloseReason) => void;
}

export interface OpenTextEditorOptions {
  /** Defaults to the kind's primary field. A field the kind does not have refuses to open. */
  readonly field?: EditableTextField;
  /**
   * Escape hatch for content core cannot read — plugin data, `host-image.alt`. Supply both and the
   * content kind stops mattering; `onCommit` replaces the built-in `annotations.update` outright.
   */
  readonly initialValue?: string;
  readonly onCommit?: (value: string) => void;
}

/** Enough of a change event for React's synthetic one and the DOM's own to both satisfy it. */
export interface TextInputEventLike {
  readonly target: unknown;
}

export interface KeyEventLike {
  readonly key: string;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

export interface DoubleClickEventLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly currentTarget: unknown;
}

/** Spread onto a textarea. Deliberately carries no pointer handlers — see `ref`. */
export interface TextEditorProps {
  readonly value: string;
  readonly dir: TextDirection;
  readonly rows: number;
  readonly 'aria-label': string;
  /**
   * Present when the tag draws a string the host resolved from the model, and this box is editing
   * the persisted fallback underneath it. Without it a host cannot explain why typing changes
   * nothing on screen; refusing to open would instead make the fallback unreachable from any UI.
   */
  readonly 'data-vl-text-source'?: 'tag-fallback';
  readonly onChange: (event: TextInputEventLike) => void;
  readonly onKeyDown: (event: KeyEventLike) => void;
  readonly onBlur: () => void;
}

export interface TextEditorSnapshot {
  /** The annotation being edited, or `null` — including after a refused open. */
  readonly annotationId: string | null;
  /** Which field was resolved. `null` when a host is driving the value itself. */
  readonly field: EditableTextField | null;
  readonly multiline: boolean;
  readonly props: TextEditorProps;
}

interface OpenState {
  readonly id: string;
  readonly field: EditableTextField | null;
  readonly multiline: boolean;
  readonly direction: TextDirection;
  readonly tagFallback: boolean;
  readonly onCommit: ((value: string) => void) | undefined;
  value: string;
}

const FIELD_NAMES: Record<EditableTextField, string> = {
  text: 'Text',
  title: 'Title',
  primary: 'Primary text',
  secondary: 'Secondary text',
  label: 'Label',
};

/**
 * One open editor, and the state that says which annotation it is over.
 *
 * `open`/`cancel` are ordinary calls rather than runtime state on purpose: which annotation is
 * being edited is a host concern that framework state already models well, and core has no DOM
 * opinions to justify holding it.
 */
export class TextEditorController implements SnapshotSource<TextEditorSnapshot> {
  readonly #host: TextEditorHost;
  readonly #follow: TextEditorFollow | undefined;
  readonly #onClose: ((reason: TextEditorCloseReason) => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #cache = revisionCache<TextEditorSnapshot>();
  #revision = 0;
  #open: OpenState | undefined;
  #element: Element | null = null;
  #releaseFollow: (() => void) | undefined;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  public constructor(options: TextEditorOptions) {
    this.#host = options.host;
    this.#follow = options.follow;
    this.#onClose = options.onClose;
    // An annotation deleted from under an open editor would otherwise be written back to on the
    // blur its own removal fires.
    this.#unsubscribe = options.host.annotations.subscribe(() => {
      const open = this.#open;
      if (open !== undefined && this.#host.annotations.get(open.id) === undefined) {
        this.#close('gone');
      }
    });
  }

  /**
   * Pass to the textarea as its ref. One stable identity, so a re-render neither detaches it in
   * React nor re-fires it in Vue. Registers the element with the follow registry.
   *
   * A press inside the field belongs to the field: core's own pointer listener ignores presses
   * from form controls (`isHostChrome` in `editing.ts`), so nothing here has to stop propagation.
   */
  public readonly ref = (element: Element | null): void => {
    if (this.#element === element) return;
    this.#releaseFollow?.();
    this.#releaseFollow = undefined;
    this.#element = element;
    if (element === null) return;
    this.#trackLabel();
    this.#focus();
  };

  /**
   * Optional: the double-click gesture, with the guard that is easy to get wrong.
   *
   * Core binds `dblclick` on the same boundary for the duration of a multi-point authoring
   * session, and adds its listener second — so without the phase check, finishing a route over an
   * existing label opens an editor on top of the leader the same gesture just committed. One of
   * the two hand-rolled demos omits it and only gets away with it by never starting a session.
   */
  public readonly boundaryProps: { readonly onDoubleClick: (event: DoubleClickEventLike) => void } =
    { onDoubleClick: (event) => this.#doubleClick(event) };

  public getSnapshot(): TextEditorSnapshot {
    return this.#cache(this.#revision, () => this.#build());
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** `false` when the annotation is gone, or the kind has no such field and no escape hatch. */
  public open(id: string, options: OpenTextEditorOptions = {}): boolean {
    if (this.#disposed) return false;
    const content = this.#host.annotations.get(id)?.content;
    if (content === undefined) return false;
    const stored = readTextField(content, options.field);
    const driven = options.onCommit !== undefined && options.initialValue !== undefined;
    if (stored === undefined && !driven) return false;
    const field = stored === undefined ? null : options.field ?? primaryTextField(content) ?? null;
    this.#open = {
      id,
      field,
      multiline: field === null ? true : isMultilineField(content, field),
      direction: directionOf(content),
      tagFallback: content.kind === 'tag' && content.reference !== undefined,
      onCommit: options.onCommit,
      value: options.initialValue ?? stored ?? '',
    };
    this.#trackLabel();
    this.#publish();
    this.#focus();
    return true;
  }

  public setValue(value: string): void {
    const open = this.#open;
    if (open === undefined || open.value === value) return;
    open.value = value;
    this.#publish();
  }

  /**
   * Writes the value and closes. Blur and Enter both land here.
   *
   * Closes *first*: detaching a focused element fires `blur` synchronously, so a commit that wrote
   * before closing would re-enter through its own teardown.
   *
   * No dirty check. `DocumentEngine` already drops an unchanged patch and an unchanged
   * transaction, so a redundant comparison here would be a second implementation of a rule the
   * engine has to enforce anyway.
   */
  public commit(): void {
    const open = this.#open;
    if (open === undefined) return;
    this.#close('commit');
    if (open.onCommit !== undefined) {
      open.onCommit(open.value);
      return;
    }
    if (open.field === null) return;
    const content = this.#host.annotations.get(open.id)?.content;
    if (content === undefined) return;
    const next = writeTextField(content, open.field, open.value);
    if (next === undefined) return;
    this.#host.annotations.update(open.id, { content: next });
  }

  /** Closes without writing. Escape, and what a binding's `close()` calls. */
  public cancel(): void {
    this.#close('cancel');
  }

  public dispose(): void {
    if (this.#disposed) return;
    // Through `#close`, and *before* the listeners go, so an editor torn down with a value still in
    // it says so. Silently discarding what someone typed is the one failure this class must not
    // have: a binding rebuilding on a dependency change would otherwise drop a half-written note
    // with nothing to tell the host it happened.
    if (this.#open !== undefined) this.#close('gone');
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#releaseFollow?.();
    this.#releaseFollow = undefined;
    this.#element = null;
    this.#publish();
    this.#listeners.clear();
  }

  readonly #onChange = (event: TextInputEventLike): void => {
    const value = (event.target as { readonly value?: unknown } | null)?.value;
    if (typeof value === 'string') this.setValue(value);
  };

  readonly #onKeyDown = (event: KeyEventLike): void => {
    const open = this.#open;
    if (open === undefined) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key !== 'Enter') return;
    // Shift+Enter is a newline only where the field is prose. On a single-line field it still
    // commits, rather than storing a line break a tag cannot draw.
    if (open.multiline && event.shiftKey) return;
    event.preventDefault();
    this.commit();
  };

  readonly #onBlur = (): void => { this.commit(); };

  #build(): TextEditorSnapshot {
    const open = this.#open;
    const value = open?.value ?? '';
    const multiline = open?.multiline ?? false;
    const props: TextEditorProps = Object.freeze({
      value,
      dir: open?.direction ?? 'auto',
      rows: multiline ? Math.max(1, value.split('\n').length) : 1,
      'aria-label': open === undefined
        ? 'Annotation text'
        : `${open.field === null ? 'Text' : FIELD_NAMES[open.field]} of annotation ${open.id}`,
      ...(open?.tagFallback === true ? { 'data-vl-text-source': 'tag-fallback' as const } : {}),
      onChange: this.#onChange,
      onKeyDown: this.#onKeyDown,
      onBlur: this.#onBlur,
    });
    return Object.freeze({
      annotationId: open?.id ?? null,
      field: open?.field ?? null,
      multiline,
      props,
    });
  }

  #close(reason: TextEditorCloseReason): void {
    if (this.#open === undefined) return;
    this.#open = undefined;
    this.#releaseFollow?.();
    this.#releaseFollow = undefined;
    this.#publish();
    this.#onClose?.(reason);
  }

  /**
   * `onMissing: 'hold'` — the one deliberate exception to the follow contract's uniform rule.
   *
   * The contract hides an off-screen target with `visibility: hidden`; the browser blurs a hidden
   * focused element, and blur commits. Hiding would therefore commit a half-typed value on an
   * accidental orbit, so the editor stays alive off-screen instead.
   */
  #trackLabel(): void {
    this.#releaseFollow?.();
    this.#releaseFollow = undefined;
    const open = this.#open;
    const element = this.#element;
    if (open === undefined || element === null) return;
    this.#releaseFollow = this.#follow?.register(
      { kind: 'label', id: open.id },
      element,
      { onMissing: 'hold' },
    );
  }

  /**
   * Double-clicking a label means "retype this one", so the whole value is selected: the second
   * gesture after applying a template is almost always replacing its empty or placeholder text.
   */
  #focus(): void {
    if (this.#open === undefined) return;
    const element = this.#element as {
      focus?: () => void;
      select?: () => void;
    } | null;
    element?.focus?.();
    element?.select?.();
  }

  #doubleClick(event: DoubleClickEventLike): void {
    if (this.#disposed || this.#host.authoring.getSnapshot().phase !== 'idle') return;
    const hit = this.#host.editing.hitTestScreen(localPoint(event));
    if (hit?.kind === 'label') this.open(hit.id);
  }

  #publish(): void {
    this.#revision += 1;
    for (const listener of [...this.#listeners]) listener();
  }
}

function directionOf(content: AnnotationContent): TextDirection {
  return 'direction' in content && content.direction !== undefined ? content.direction : 'auto';
}

/**
 * Duck-typed for the same reason the follow registry's style access is: core is handed elements and
 * must not assume a DOM global exists just to measure one.
 */
function localPoint(event: DoubleClickEventLike): Vec2 {
  const rect = (event.currentTarget as {
    getBoundingClientRect?: () => { readonly left: number; readonly top: number };
  } | null)?.getBoundingClientRect?.();
  return rect === undefined
    ? { x: event.clientX, y: event.clientY }
    : { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
