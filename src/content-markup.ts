import {
  DefinitionsCapability,
  type DefinitionDocumentPort,
} from './definitions.js';
import {
  ExtensionRuntime,
  type ExtensionLimits,
  type PluginDescriptor,
} from './extensions.js';
import {
  ImageResolutionManager,
  imagePortFromAdapter,
  type HostImagePort,
  type ImageDiagnostic,
} from './images.js';
import {
  OcclusionManager,
  occlusionPortFromAdapter,
  type HostOcclusionPort,
} from './occlusion.js';
import type { AdapterError } from './errors.js';
import type { HostAdapterBundle } from './host.js';

export interface ContentMarkupModuleOptions {
  readonly definitions: DefinitionDocumentPort;
  readonly adapters?: Pick<HostAdapterBundle, 'images' | 'occlusion'>;
  readonly imagePort?: HostImagePort;
  readonly occlusionPort?: HostOcclusionPort;
  readonly plugins?: readonly PluginDescriptor[];
  readonly extensionLimits?: ExtensionLimits;
  readonly invalidate: () => void;
  readonly diagnostic: (diagnostic: ImageDiagnostic | AdapterError) => void;
}

export interface ContentMarkupModules {
  readonly definitions: DefinitionsCapability;
  readonly images: ImageResolutionManager;
  readonly occlusion: OcclusionManager;
  readonly extensions: ExtensionRuntime;
  dispose(): void;
}

/**
 * Builds the four services that turn stored content into something drawable: styles, images,
 * occlusion and plugins.
 *
 * They are created together because they share a lifetime and the same two callbacks — redraw, and
 * report a problem — and disposing them in the wrong order leaves a plugin running against services
 * that are already gone.
 */
export function createContentMarkupModules(
  options: ContentMarkupModuleOptions,
): ContentMarkupModules {
  const definitions = new DefinitionsCapability(options.definitions);
  const imagePort = options.imagePort
    ?? (options.adapters?.images === undefined ? undefined : imagePortFromAdapter(options.adapters.images));
  const occlusionPort = options.occlusionPort
    ?? (options.adapters?.occlusion === undefined
      ? undefined
      : occlusionPortFromAdapter(options.adapters.occlusion));
  const images = new ImageResolutionManager(imagePort, {
    invalidate: options.invalidate,
    diagnostic: options.diagnostic,
  });
  const occlusion = new OcclusionManager(occlusionPort, {
    invalidate: options.invalidate,
    diagnostic: options.diagnostic,
  });
  const extensions = new ExtensionRuntime(options.plugins ?? [], {
    ...(options.extensionLimits === undefined ? {} : { limits: options.extensionLimits }),
    invalidate: options.invalidate,
  });
  let disposed = false;
  return {
    definitions,
    images,
    occlusion,
    extensions,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      extensions.dispose();
      occlusion.dispose();
      images.dispose();
    },
  };
}
