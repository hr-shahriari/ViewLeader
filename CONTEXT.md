# ViewLeader annotations

ViewLeader organizes labels and their leader lines around the 3D objects they describe.

## Language

**Annotation**:
A label together with one or more anchored leader lines that identify what the label describes.

**Label**:
The visible text, badge, image, or other content of an annotation, including its enclosure.
_Avoid_: Leader, when referring only to the text or badge.

**Anchor**:
The point or region on the model identified by a leader line.

**Leader line**:
The line connecting an anchor to its label.
_Avoid_: Label, when referring to the connecting line.

**Model rectangle**:
The rectangle enclosing the annotated model or group as viewed from the current camera.
_Avoid_: Anchor bounds, which describe only the annotation targets.

**Layout frame**:
The rectangle around which annotations are arranged. It may represent the model rectangle or a rectangle drawn by the user.

**Quadrant**:
One of the four regions formed by dividing a rectangle at its horizontal and vertical midpoints: top left, top right, bottom left, and bottom right.

**Exit**:
The point where a leader line leaves the model rectangle on its way to the label.

**Landing**:
The final segment of a leader line where it joins the label.

**Outside-only placement**:
An arrangement that keeps labels outside the model rectangle even when this puts them partly or entirely off screen.
