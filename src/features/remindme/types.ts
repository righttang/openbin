export interface CapturePhoto {
  id: string;
  sha256: string;
  size: number;
  order: number;
  received_at?: string | null;
  deleted_at?: string | null;
}

export interface Capture {
  id: string;
  bin_id: string;
  sequence: number;
  state: 'uploading' | 'queued' | 'processing' | 'applied' | 'superseded' | 'failed' | 'expired';
  captured_at: string;
  received_at: string | null;
  expires_at: string;
  cleanup_completed_at: string | null;
  error_category?: string | null;
  photos: CapturePhoto[];
}

export interface CaptureConfig {
  maxPhotos: number;
  maxPhotoBytes: number;
  supportedMimeTypes: string[];
  uploadExpiryMs: number;
  modelConfigured: boolean;
}

export interface LocalPhoto extends CapturePhoto {
  name: string;
  blob?: Blob;
}

export interface CaptureDraft {
  id: string;
  ownerId: string;
  binId: string;
  createdAt: string;
  expiresAt: string;
  sealed: boolean;
  updatedAt?: number;
  photos: LocalPhoto[];
}

export interface InventoryItem {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  quantity: number | null;
  bin_id: string;
  bin_name: string;
  location_name: string;
  area_name: string | null;
  last_seen_at: string | null;
  observation_state: string | null;
  observation_id?: string | null;
  crop_url?: string | null;
  photo_preview_url?: string | null;
}

export interface PhotoHistoryItem {
  observation_id: string;
  item_id: string | null;
  name: string;
  description: string;
  aliases: string[];
  quantity: number | null;
  crop_url: string | null;
}

export interface PhotoHistory {
  capture_id: string;
  photo_id: string;
  bin_id: string;
  bin_name: string;
  captured_at: string;
  state: Capture['state'];
  sequence: number;
  error_category: string | null;
  preview_url: string | null;
  items: PhotoHistoryItem[];
}
