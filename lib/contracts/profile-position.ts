export const fieldPositions = ['Cutter', 'Handler', '防守大闸', '六边形'] as const;
export type FieldPosition = typeof fieldPositions[number] | '';

// Older clients can still submit a profile form opened before the labels changed.
export function fieldPosition(value: unknown): FieldPosition | undefined {
    switch (value) {
        case '接盘手': return 'Cutter';
        case '持盘手': return 'Handler';
        case '防守组': return '防守大闸';
        case '': return '';
        default: return fieldPositions.find(position => position === value);
    }
}
