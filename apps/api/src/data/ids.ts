import { uuidv7 } from 'uuidv7';

/** UUIDv7: time-sortable, index-friendly (PROJECTPLAN.md §4.4, §5.5). */
export const newId = (): string => uuidv7();
