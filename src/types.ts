// Geometry Primitives

export interface Vector3d {
    x: number
    y: number
    z: number
}

export interface Vector2d {
    x: number
    y: number
}

export interface MtextContent 
{
    type: 'mtext'
    text: string
}

export interface PointAnchor
{
    type: 'point'
    position: Vector3d;
}

export interface Annotation
{
    id: string;
    anchor: PointAnchor
    content:MtextContent
    styleId: string
    visible: boolean
}

// Leader Styling

// export type AnchorPlugType = 'Arrow1' | 'Arrow2' | 'Arrow3' | 'Dot' | 'None';

// export type LabelPlugType = 'Disc' | 'Crosshair' | 'Diamond' | 'Square' | 'None';

// export type RoutingMode = 'Orthogonal' | 'DiagonalOrthogonal' | 'Vertical';

// export type LandingSide = 'Auto' | 'Left' | 'Right';

// export interface LineStyle {
//     Color?: string;
//     Width?: number;
//     Dash?: boolean;
//     Opacity?: number;
// }

// export interface RoutingStyle {
//     Mode?: RoutingMode;
// }

// export interface PlugStyle<TShape = string> {
//     Shape?: TShape;
//     Size?: number;
//     Color?: string;
//     OutlineColor?: string;
//     OutlineSize?: number;
// }

// export interface LandingStyle {
//     Length?: number;
//     Side?: LandingSide;
//     Gap?: number;
// }

// export interface TextStyle {
//     FontSize?: number;
//     FontWeight?: 'normal' | 'bold';
//     Color?: string;
// }

// export interface ContentStyle {
//     BackgroundColor?: string;
//     BackgroundOpacity?: number;
//     BorderRadius?: number;
// }

// export interface LeaderStyleDefinition {
//     Id: string;
//     Name?: string;
//     Line: LineStyle;
//     Routing: RoutingStyle;
//     AnchorPlug: PlugStyle<AnchorPlugType>;
//     LabelPlug: PlugStyle<LabelPlugType>;
//     Landing: LandingStyle;
//     Text?: TextStyle;
//     Content?: ContentStyle;
// }