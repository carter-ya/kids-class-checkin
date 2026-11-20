ALTER TABLE users ADD COLUMN course_guide_done INTEGER NOT NULL DEFAULT 0;
UPDATE users SET course_guide_done=1
WHERE id IN (SELECT actor_id FROM family_events WHERE detail LIKE '添加课程「%');
