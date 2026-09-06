// The framework-agnostic controllers both bindings hand to a host, re-exported once so the React
// and Vue entries publish the same names.
export type { SnapshotSource } from './lifecycle.js';
export { EditingKeyboard, type EditingKeyboardOptions } from './keyboard.js';
export {
  HandlesController,
  type HandleEntry,
  type HandleKind,
  type HandlePointerProps,
  type HandlesTarget,
} from './handles.js';
export {
  TextEditorController,
  isMultilineField,
  primaryTextField,
  readTextField,
  writeTextField,
  type EditableTextField,
  type OpenTextEditorOptions,
  type TextEditorCloseReason,
  type TextEditorProps,
  type TextEditorSnapshot,
} from './text-editor.js';
export {
  StyleEditor,
  type SelectionValue,
  type StyleEditorSnapshot,
  type StyleField,
  type StyleFieldState,
} from './style-editor.js';
export {
  TemplateDraft,
  captureTemplateDefaults,
  type TemplateCaptureOptions,
  type TemplateCaptureResult,
  type TemplateCaptureSource,
  type TemplateDraftIssue,
  type TemplateDraftOptions,
  type TemplateDraftPatch,
  type TemplateDraftSnapshot,
} from './template-draft.js';
export {
  FollowRegistry,
  followTargetKey,
  type FollowMissingBehaviour,
  type FollowOptions,
  type FollowTarget,
} from './follow.js';
