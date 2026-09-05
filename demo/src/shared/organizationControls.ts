// The placement controls are host chrome: ViewLeader exposes the policy, while each host decides
// where it belongs. The same controls fit a bottom bar or an inspector section.
import type { PlacementMode, ViewLeader } from 'viewleader';
import type { ControlBar, ControlSelect } from './controls';

export interface OrganizationControls {
  readonly placement: ControlSelect;
  readonly keepOutside: HTMLInputElement;
  disabled(value: boolean): void;
}

const PLACEMENT_OPTIONS: readonly { readonly value: PlacementMode; readonly label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'sides', label: 'Side routing' },
  { value: 'rows', label: 'Row routing' },
  { value: 'quadrants', label: 'Quadrant routing' },
];

export function mountOrganizationControls(
  bar: Pick<ControlBar, 'element' | 'select'>,
  leader: ViewLeader,
  say: (message: string) => void,
): OrganizationControls {
  const placement = bar.select('Leader placement', PLACEMENT_OPTIONS, (value) => {
    leader.setPlacementMode(value as PlacementMode);
    say(`Leader placement: ${placement.element.selectedOptions[0]?.textContent ?? value}.`);
  });
  placement.set(leader.placementMode);
  placement.element.parentElement?.classList.add('organization-placement');

  const label = document.createElement('label');
  label.className = 'control-select organization-outside';
  label.style.pointerEvents = 'auto';
  const keepOutside = document.createElement('input');
  keepOutside.type = 'checkbox';
  keepOutside.checked = leader.keepLabelsOutsideModel;
  const caption = document.createElement('span');
  caption.textContent = 'Keep labels outside model';
  label.append(keepOutside, caption);
  keepOutside.addEventListener('change', () => {
    leader.setKeepLabelsOutsideModel(keepOutside.checked);
    say(keepOutside.checked
      ? 'Labels keep clear of the current model rectangle; close zoom can put them offscreen.'
      : 'Labels may use the model rectangle again.');
  });
  bar.element.append(label);

  return {
    placement,
    keepOutside,
    disabled(value) {
      placement.element.disabled = value;
      keepOutside.disabled = value;
    },
  };
}
