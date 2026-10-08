export type Role = 'owner' | 'contributor' | 'viewer';
export type Persona = 'elder' | 'archivist' | 'explorer';
export type MemoryType = 'photo' | 'video' | 'voice_note' | 'text_note' | 'document';
export type Privacy = 'private' | 'family';
export type DatePrecision = 'day' | 'month' | 'year';

export interface UserSettings {
  textSize?: 'normal' | 'large' | 'extra-large';
  highContrast?: boolean;
  reducedMotion?: boolean;
}

export interface User {
  id: string;
  login: string;
  displayName: string;
  role: Role;
  persona: Persona;
  settings: UserSettings;
  disabled?: boolean;
  createdAt: string;
}

export interface Member {
  id: string;
  login?: string;
  displayName: string;
  role: Role;
  persona?: Persona;
  disabled: boolean;
}

export interface Media {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  mimeType: string;
  originalName: string;
  size: number;
  duration: number | null;
  url: string;
}

export interface Person {
  name: string;
  relationship: string;
}

export interface Memory {
  id: string;
  type: MemoryType;
  title: string;
  description: string;
  content: string;
  transcript: string;
  memoryDate: string | null;
  datePrecision: DatePrecision;
  location: string;
  privacy: Privacy;
  promptId: string | null;
  aiSummary: string;
  aiSource: string;
  tags: string[];
  people: Person[];
  media: Media[];
  contributor: { id: string; displayName: string };
  createdAt: string;
  updatedAt: string;
  snippet?: string | null;
}

export interface LightMemory {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  memoryDate: string | null;
  datePrecision: DatePrecision;
  privacy: Privacy;
  contributor: { id: string; displayName: string };
  thumb: string | null;
  mediaKinds: string[];
}

export interface Prompt {
  id: string;
  text: string;
  category: string;
  lifeStage: string | null;
  isCustom: boolean;
  votes: number;
  votedByMe: boolean;
  answered: number;
  createdBy: string | null;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  description: string;
  count: number;
}

export interface Stats {
  total: number;
  thisMonth: number;
  people: number;
  bytes: number;
  contributors: { id: string; displayName: string; count: number }[];
  byType: Record<string, number>;
  firstYear: number | null;
  lastYear: number | null;
}

export interface AppConfig {
  version: string;
  aiAvailable: boolean;
  maxFileMb: number;
  initialized: boolean;
}

export interface Decade {
  decade: number;
  label: string;
  count: number;
  status: 'empty' | 'sparse' | 'ok';
}
