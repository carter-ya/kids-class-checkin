ALTER TABLE users ADD COLUMN guide_done INTEGER NOT NULL DEFAULT 0;
CREATE TABLE families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(owner_id, name)
);
CREATE TABLE family_members (
  family_id INTEGER NOT NULL REFERENCES families(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  PRIMARY KEY(family_id, user_id)
);
CREATE INDEX memberships_by_user ON family_members(user_id, family_id);
CREATE TABLE family_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL REFERENCES families(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL,
  detail TEXT NOT NULL,
  happened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX events_by_family ON family_events(family_id, id DESC);

INSERT INTO families(id,name,owner_id) SELECT id,display_name || '的家',id FROM users;
INSERT INTO family_members SELECT id,owner_id,'家人' FROM families;

CREATE TABLE courses_family (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(family_id, name)
);

CREATE TABLE cycles_family (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses_family(id) ON DELETE CASCADE,
  first TEXT NOT NULL,
  last TEXT NOT NULL CHECK (last >= first),
  total INTEGER NOT NULL CHECK (total > 0),
  UNIQUE(course_id, first, last),
  UNIQUE(course_id, id)
);

CREATE TABLE cycle_checkins_family (
  course_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,
  class_date TEXT NOT NULL,
  marked_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(course_id, class_date),
  FOREIGN KEY(course_id, cycle_id) REFERENCES cycles_family(course_id, id) ON DELETE CASCADE
);


INSERT INTO courses_family(id,family_id,name) SELECT id,user_id,name FROM courses;
INSERT INTO cycles_family(id,course_id,first,last,total) SELECT id,course_id,first,last,total FROM cycles;
INSERT INTO cycle_checkins_family(course_id,cycle_id,class_date,marked_by,created_at)
SELECT a.course_id,a.cycle_id,a.class_date,c.user_id,a.created_at FROM cycle_checkins a JOIN courses c ON c.id=a.course_id;
INSERT INTO family_events(family_id,actor_id,actor_role,detail,happened_at)
SELECT c.user_id,c.user_id,'原账号','旧手账记录 · ' || c.name || ' · ' || a.class_date,a.created_at
FROM cycle_checkins a JOIN courses c ON c.id=a.course_id ORDER BY a.created_at;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='courses'),0)) WHERE name='courses_family';
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='cycles'),0)) WHERE name='cycles_family';
DROP TABLE cycle_checkins;
DROP TABLE cycles;
DROP TABLE courses;
ALTER TABLE courses_family RENAME TO courses;
ALTER TABLE cycles_family RENAME TO cycles;
ALTER TABLE cycle_checkins_family RENAME TO cycle_checkins;
CREATE INDEX checkins_by_cycle ON cycle_checkins(cycle_id, class_date);
