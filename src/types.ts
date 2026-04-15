// Geometry Primitives

export interface Vector3d {
    X: number;
    Y: number;
    Z: number;
}

export interface Vector2d {
    X: number;
    Y: number;
}

// Annotation Content Types

/** Multi-line text label. */
export interface TextContent {
    Type: 'text';
    Text: string;
    MaxWidth?: number;
}

/** Text enclosed in a geometric shape. */
export interface ShapeContent {
    Type: 'shape';
    Text: string;
    Shape: 'Circle' | 'Hexagon' | 'Chevron' | 'Rectangle' | 'Diamond';
}

/** Text centered above a horizontal line. */
export interface CenteredContent {
    Type: 'centered';
    Text: string;
}

/** Text with an underline. */
export interface UnderlinedContent {
    Type: 'underlined';
    Text: string;
}

/** Arbitrary HTML content. */
export interface HtmlContent {
    Type: 'html';
    Element?: HTMLElement;
    Html?: string;
}

export type AnnotationContent =
    | TextContent
    | ShapeContent
    | CenteredContent
    | UnderlinedContent
    | HtmlContent;

// Anchor Types

export interface PointAnchor {
    Type: 'point';
    Position: Vector3d;
}

export interface AreaAnchor {
    Type: 'area';
    Points: Vector3d[];
    Shape: 'Rectangle' | 'Circle' | 'Polygon';
    FillColor?: string;
    BorderColor?: string;
    BorderDash?: boolean;
}

export type AnnotationAnchor = PointAnchor | AreaAnchor;

export type AnchorPlugType = 'Disc' | 'Crosshair' | 'Diamond' | 'Square' | 'None';
export type LabelPlugType = 'Arrow1' | 'Arrow2' | 'Arrow3' | 'Dot' | 'None';

export interface PlugConfig {
    Shape: AnchorPlugType | LabelPlugType;
    Size?: number;
    Color?: string;
    OutlineColor?: string;
    OutlineSize?: number;
}

// Leader Style

export type RoutingMode = 'Orthogonal' | 'Vertical' | 'DiagonalOrthogonal' | 'Straight';

export interface LeaderStyleDefinition {
    Id: string;
    Name?: string;
    Line: {
        Color: string;
        Width: number;
        Dash?: boolean;
        Opacity?: number;
    };
    Text?: {
        Color?: string;
        FontSize?: number;
        FontFamily?: string;
        FontWeight?: string;
    };
    Content?: {
        BackgroundColor?: string;
        BackgroundOpacity?: number;
        BorderRadius?: number;
    };
    Routing: {
        Mode: RoutingMode;
    };
    AnchorPlug: PlugConfig;
    LabelPlug: PlugConfig;
    Landing: {
        Length: number;
        Side?: 'Left' | 'Right' | 'Auto';
        Gap?: number;
    };
}