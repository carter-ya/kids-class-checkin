-- Keep a deleted course or cycle ID from ever identifying a new one on a stale device.
CREATE TABLE courses_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE cycles_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses_v3(id) ON DELETE CASCADE,
  first TEXT NOT NULL,
  last TEXT NOT NULL CHECK (last >= first),
  total INTEGER NOT NULL CHECK (total > 0),
  UNIQUE(course_id, first, last),
  UNIQUE(course_id, id)
);

CREATE TABLE cycle_checkins_v3 (
  course_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  class_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(course_id, class_date),
  FOREIGN KEY(course_id, cycle_id) REFERENCES cycles_v3(course_id, id) ON DELETE CASCADE
);

INSERT INTO courses_v3(id,user_id,name) SELECT id,user_id,name FROM courses;
INSERT INTO cycles_v3(id,course_id,first,last,total) SELECT id,course_id,first,last,total FROM cycles;
INSERT INTO cycle_checkins_v3(course_id,cycle_id,class_date,created_at)
SELECT course_id,cycle_id,class_date,created_at FROM cycle_checkins;
DROP TABLE cycle_checkins;
DROP TABLE cycles;
DROP TABLE courses;
ALTER TABLE courses_v3 RENAME TO courses;
ALTER TABLE cycles_v3 RENAME TO cycles;
ALTER TABLE cycle_checkins_v3 RENAME TO cycle_checkins;
CREATE INDEX checkins_by_cycle ON cycle_checkins(cycle_id, class_date);
