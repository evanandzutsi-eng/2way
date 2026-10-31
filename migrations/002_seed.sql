-- Default settings, the five launch rooms and the achievement catalogue.
-- ON CONFLICT DO NOTHING keeps this safe if an operator pre-created any row.

INSERT INTO app_settings (key, value) VALUES
  ('member_limit',          '50'),
  ('room_retention_days',   '365'),
  ('dm_retention_days',     '365'),
  ('invite_ttl_days',       '7'),
  ('rank_thresholds',       '[
      {"name":"Rookie",   "minXp":0},
      {"name":"Regular",  "minXp":100},
      {"name":"Star",     "minXp":300},
      {"name":"Master",   "minXp":700},
      {"name":"Elite",    "minXp":1500},
      {"name":"Ultimate", "minXp":3000}
  ]')
ON CONFLICT (key) DO NOTHING;

INSERT INTO rooms (slug, name, description, color, icon, sort_order) VALUES
  ('the-square', 'The Square', 'General gist. Say anything, start anything.',  'violet', 'chat',   10),
  ('late-night', 'Late Night', 'Memes, jokes and 2am thoughts.',               'indigo', 'moon',   20),
  ('match-day',  'Match Day',  'Football talk, banter and predictions.',       'green',  'ball',   30),
  ('chop-life',  'Chop Life',  'Weekend plans, outings and good times.',       'amber',  'spark',  40),
  ('game-zone',  'Game Zone',  'Gaming sessions, clips and lobbies.',          'cyan',   'pad',    50)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO achievements (code, name, description, icon, xp_reward, sort_order) VALUES
  ('welcome',          'In The Circle',   'Joined 2WaY.',                                   'door',   10, 10),
  ('profile_complete', 'Looking Fresh',   'Set a status message on your profile.',           'star',   40, 20),
  ('first_words',      'First Words',     'Sent your first room message.',                  'chat',   10, 30),
  ('explorer',         'Room Hopper',     'Posted in five different rooms.',                'map',    40, 40),
  ('crowd_pleaser',    'Crowd Pleaser',   'Got 25 reactions from mates.',                   'fire',   60, 50),
  ('week_streak',      'Regular Face',    'Active on 7 different days.',                    'flame',  50, 60),
  ('month_regular',    'Day One',         'Active on 30 different days.',                   'crown', 150, 70)
ON CONFLICT (code) DO NOTHING;
