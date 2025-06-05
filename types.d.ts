import { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

declare global {
    interface IConversation {
        conversation_id: string;
        role: 'user' | 'assistant';
        content: string;
        user_id: string;
        is_sensitive: boolean;
        personality_key: string;
        created_at: string;
    }

    interface IPayload {
        user: IUser;
        supabase: SupabaseClient;
        timestamp: string;
    }

    interface IDevice {
        device_id: string;
        volume: number;
        is_ota: boolean;
        is_reset: boolean;
        mac_address: string;
        user_code: string;
    }

    interface IPersonality {
        personality_id: string;
        is_doctor: boolean;
        is_child_voice: boolean;
        is_story: boolean;
        key: string;
        oai_voice: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Aoede' | 'Leda' | 'Orus' | 'Zephyr';
        voice_description: string;
        title: string;
        subtitle: string;
        short_description: string;
        character_prompt: string;
        voice_prompt: string;
        creator_id: string | null;
    }

    interface ILanguage {
        language_id: string;
        code: string;
        name: string;
        flag: string;
    }

    interface IDoctorMetadata {
        doctor_name: string;
        specialization: string;
        hospital_name: string;
        favorite_phrases: string;
    }

    interface IUserMetadata {}
    interface IBusinessMetadata {}

    type UserInfo =
        | {
            user_type: 'user';
            user_metadata: IUserMetadata;
        }
        | {
            user_type: 'doctor';
            user_metadata: IDoctorMetadata;
        }
        | {
            user_type: 'business';
            user_metadata: IBusinessMetadata;
        };

    interface INote {
        note_id: string;
        user_id: string;
        title: string;
        body: string;
        created_at: string;
        updated_at: string;
        image_id?: string | null;
    }

    interface IUser {
        user_id: string;
        avatar_url: string;
        is_premium: boolean;
        email: string;
        supervisor_name: string;
        supervisee_name: string;
        supervisee_persona: string;
        supervisee_age: number;
        personality_id: string;
        personality?: IPersonality;
        language: ILanguage;
        language_code: string;
        session_time: number;
        user_info: UserInfo;
        device_id: string;
        device?: IDevice;
    }

    interface IBook {
        book_id: string;
        book_name: string;
        file_path: string;
        total_pages: number;
        is_public: boolean;
        created_at: string;
        author?: string;
        description?: string;
    }

    interface IReadingHistory {
        history_id: string;
        user_id: string;
        book_name: string;
        current_page: number;
        total_pages: number;
        last_read_at: string;
        created_at: string;
    }

    interface IReadingSettings {
        settings_id: string;
        user_id: string;
        reading_mode: 'paragraphs' | 'sentences' | 'fullpage';
        reading_amount: number;
        created_at: string;
        updated_at: string;
    }

    interface ISchedule {
        schedule_id: string;
        user_id: string;
        title: string;
        description?: string | null;
        scheduled_time: string; // HH:MM:SS format (Supabase TIME type)
        schedule_type: 'once' | 'daily' | 'weekly' | 'custom';
        schedule_pattern?: ISchedulePattern | null;
        target_date?: string | null; // YYYY-MM-DD format for one-time schedules
        is_active: boolean;
        created_at: string;
        updated_at: string;
    }

    interface ISchedulePattern {
        // For weekly schedules: array of day numbers (0=Sunday, 1=Monday, etc.)
        weekdays?: number[];
        // For custom patterns: skip every N days
        skip_days?: number;
        // For custom patterns: specific dates
        specific_dates?: string[];
        // End date for recurring schedules
        end_date?: string | null;
    }

    interface IScheduleWithCurrentTime {
        schedules: ISchedule[];
        current_time_utc7: string; // ISO string in UTC+7
        current_date_utc7: string; // YYYY-MM-DD format
    }
}
