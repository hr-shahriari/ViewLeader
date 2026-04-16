import type { LeaderStyleDefinition } from '../types';

const STYLE_DEFAULTS: Omit<LeaderStyleDefinition, 'Id'> = {
    Line: {
        Color: '#c8cad3',
        Width: 1,
        Dash: false,
        Opacity: 1,
    },
    Routing: {
        Mode: 'Orthogonal',
    },
    AnchorPlug: {
        Shape: 'Arrow1',
        Size: 5,
        Color: '#000000',
        OutlineColor: '#ffffff',
        OutlineSize: 1,
    },
    LabelPlug: {
        Shape: 'Disc',
        Size: 5,
        Color: '#000000',
        OutlineColor: '#ffffff',
        OutlineSize: 1,
    },
    Landing: {
        Length: 20,
        Side: 'Auto',
        Gap: 5,
    },
};

export function CreateStyle(
    partial: { Id: string } & Partial<Omit<LeaderStyleDefinition, 'Id'>>,
): LeaderStyleDefinition {
    return {
        Id: partial.Id,
        Name: partial.Name,
        Line: { ...STYLE_DEFAULTS.Line, ...partial.Line },
        Routing: { ...STYLE_DEFAULTS.Routing, ...partial.Routing },
        AnchorPlug: { ...STYLE_DEFAULTS.AnchorPlug, ...partial.AnchorPlug },
        LabelPlug: { ...STYLE_DEFAULTS.LabelPlug, ...partial.LabelPlug },
        Landing: { ...STYLE_DEFAULTS.Landing, ...partial.Landing },
        Text: partial.Text,
        Content: partial.Content,
    };
}
