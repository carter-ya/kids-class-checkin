CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE cycles (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  first TEXT NOT NULL,
  last TEXT NOT NULL CHECK (last >= first),
  total INTEGER NOT NULL CHECK (total > 0),
  UNIQUE(course_id, first, last),
  UNIQUE(course_id, id)
);

INSERT INTO courses(user_id, name) SELECT id, '我的课程' FROM users;
INSERT INTO cycles(course_id, first, last, total)
SELECT id, '2026-11-01', '2027-11-30', 35 FROM courses;

CREATE TABLE cycle_checkins (
  course_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  class_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(course_id, class_date),
  FOREIGN KEY(course_id, cycle_id) REFERENCES cycles(course_id, id) ON DELETE CASCADE
);
CREATE INDEX checkins_by_cycle ON cycle_checkins(cycle_id, class_date);
INSERT INTO cycle_checkins(course_id, cycle_id, class_date, created_at)
SELECT c.id, p.id, old.class_date, old.created_at FROM checkins old
JOIN courses c ON c.user_id=old.user_id JOIN cycles p ON p.course_id=c.id;
DROP TABLE checkins;
