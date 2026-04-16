export type WaveformType = 'sine' | 'square' | 'triangle' | 'sawtooth';

export interface GeneratorSettings {
  type: WaveformType;
  frequency: number;
  amplitude: number;
  offset: number;
}

export interface SignalPoint {
  t: number;
  v: number;
}
