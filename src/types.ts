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
    offset?: Vector2d
    locked?: boolean
}
