export type CaptureState = 'uploading' | 'queued' | 'processing' | 'applied' | 'superseded' | 'failed' | 'expired';
export interface CaptureBatch {
  id: string;
  bin_id: string;
  created_by: string;
  source: string;
  device_id: string | null;
  event_id: string | null;
  captured_at: string;
  received_at: string | null;
  sequence: number;
  manifest_json: string | null;
  state: CaptureState;
  expires_at: string;
  created_at: string;
  updated_at: string;
  cleanup_completed_at: string | null;
}
export interface CapturePhoto {
  capture_id: string;
  id: string;
  position: number;
  sha256: string;
  size: number;
  mime_type: string;
  storage_path: string;
  received_at: string | null;
  deleted_at: string | null;
}
export interface PhotoManifestEntry { id: string; sha256: string; size: number; order: number }
