ALTER TABLE profiles ADD COLUMN ui_language TEXT NOT NULL DEFAULT 'en' CHECK (ui_language IN ('en', 'el'));
