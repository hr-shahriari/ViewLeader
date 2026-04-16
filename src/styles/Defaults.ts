import type { LeaderStyleDefinition } from '../types';
import { CreateStyle } from './LeaderStyle';

export const DefaultStyles: LeaderStyleDefinition[] = [
    CreateStyle({
        Id: 'standard',
        Name: 'Standard',
        Line: { Color: '#d0d3dc', Width: 1.2 },
        Routing: { Mode: 'DiagonalOrthogonal' },
        AnchorPlug: { Shape: 'None' },
        LabelPlug: { Shape: 'Disc', Size: 5 },
        Landing: { Length: 24, Side: 'Auto', Gap: 3 },
        Text: { FontSize: 12, Color: '#e8eaf0' },
        Content: { BackgroundOpacity: 0 },
    }),

    CreateStyle({
        Id: 'vertical',
        Name: 'Vertical',
        Line: { Color: '#d0d3dc', Width: 1.2 },
        Routing: { Mode: 'Vertical' },
        AnchorPlug: { Shape: 'None' },
        LabelPlug: { Shape: 'Disc', Size: 5 },
        Landing: { Length: 24 },
    }),

    CreateStyle({
        Id: 'dimension',
        Name: 'Dimension',
        Line: { Color: '#9098ac', Width: 1 },
        Routing: { Mode: 'DiagonalOrthogonal' },
        AnchorPlug: { Shape: 'Arrow3', Size: 7 },
        LabelPlug: { Shape: 'Crosshair', Size: 6 },
        Landing: { Length: 14, Gap: 2 },
        Text: { FontSize: 11, Color: '#b8bcc8' },
    }),

    CreateStyle({
        Id: 'block-circle',
        Name: 'Block Circle',
        Line: { Color: '#6baaf7', Width: 1.2 },
        Text: { FontSize: 12, FontWeight: 'bold', Color: '#ffffff' },
        Content: { BackgroundColor: '#3a72c4', BackgroundOpacity: 0.95, BorderRadius: 50 },
    }),

    CreateStyle({
        Id: 'block-hexagon',
        Name: 'Block Hexagon',
        Line: { Color: '#3dbe80', Width: 1.2 },
        Text: { FontWeight: 'bold', Color: '#ffffff' },
        Content: { BackgroundColor: '#267d52', BackgroundOpacity: 0.95, BorderRadius: 2 },
    }),

    CreateStyle({
        Id: 'block-chevron',
        Name: 'Block Chevron',
        Line: { Color: '#e5645f', Width: 1.2 },
        Text: { FontWeight: 'bold', Color: '#ffffff' },
        Content: { BackgroundColor: '#b8312d', BackgroundOpacity: 0.95, BorderRadius: 2 },
    }),
];

export function GetDefaultStyles(): LeaderStyleDefinition {
    return DefaultStyles[0];
}

