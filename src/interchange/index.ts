// BCF 2.1: the file format construction tools use to pass issues between each other.
//
// Exporting turns annotations into topics a colleague can open in Revit, Navisworks or Solibri.
// Importing brings theirs back the other way. A round trip is lossless — anything this build does
// not understand is carried through untouched rather than dropped.
export * from './archive.js';
export * from './apply.js';
export * from './bcf.js';
export * from './document-ops.js';
export * from './sheet.js';
export * from './types.js';
export * from './xml.js';
