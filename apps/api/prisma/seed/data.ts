import type {
  AgeRating,
  DayType,
  MovieStatus,
  Role,
  SeatType,
} from '../../src/generated/prisma/enums';

export interface SeedUser {
  email: string;
  fullName: string;
  role: Role;
  passwordEnv: 'SEED_ADMIN_PASSWORD' | 'SEED_STAFF_PASSWORD' | 'SEED_USER_PASSWORD';
}

export const USERS: SeedUser[] = [
  {
    email: 'admin@ticketify.local',
    fullName: 'Quản trị viên',
    role: 'ADMIN',
    passwordEnv: 'SEED_ADMIN_PASSWORD',
  },
  {
    email: 'staff@ticketify.local',
    fullName: 'Nhân viên soát vé',
    role: 'STAFF',
    passwordEnv: 'SEED_STAFF_PASSWORD',
  },
  {
    email: 'user@ticketify.local',
    fullName: 'Khách hàng mẫu',
    role: 'USER',
    passwordEnv: 'SEED_USER_PASSWORD',
  },
];

/** Prices in VND per seat (a couple seat is two seats sharing a coupleGroup). */
export const SEAT_PRICES: Record<SeatType, Record<DayType, number>> = {
  STANDARD: { WEEKDAY: 75_000, WEEKEND: 90_000, HOLIDAY: 110_000 },
  VIP: { WEEKDAY: 95_000, WEEKEND: 115_000, HOLIDAY: 135_000 },
  COUPLE: { WEEKDAY: 100_000, WEEKEND: 120_000, HOLIDAY: 145_000 },
};

export const GENRES = [
  { slug: 'hanh-dong', name: 'Hành động' },
  { slug: 'tinh-cam', name: 'Tình cảm' },
  { slug: 'tam-ly', name: 'Tâm lý' },
  { slug: 'khoa-hoc-vien-tuong', name: 'Khoa học viễn tưởng' },
  { slug: 'hoat-hinh', name: 'Hoạt hình' },
  { slug: 'gia-dinh', name: 'Gia đình' },
  { slug: 'kinh-di', name: 'Kinh dị' },
] as const;

type GenreSlug = (typeof GENRES)[number]['slug'];

export interface SeedMovie {
  slug: string;
  title: string;
  duration: number;
  ageRating: AgeRating;
  releaseDate: string;
  status: MovieStatus;
  genres: GenreSlug[];
}

/** Fictional titles. */
export const MOVIES: SeedMovie[] = [
  {
    slug: 'mua-ha-cuoi-cung',
    title: 'Mùa Hạ Cuối Cùng',
    duration: 112,
    ageRating: 'T13',
    releaseDate: '2026-10-10',
    status: 'NOW_SHOWING',
    genres: ['tinh-cam', 'tam-ly'],
  },
  {
    slug: 'biet-doi-sao-bang',
    title: 'Biệt Đội Sao Băng',
    duration: 128,
    ageRating: 'T16',
    releaseDate: '2026-10-24',
    status: 'NOW_SHOWING',
    genres: ['hanh-dong', 'khoa-hoc-vien-tuong'],
  },
  {
    slug: 'can-nha-so-13',
    title: 'Căn Nhà Số 13',
    duration: 104,
    ageRating: 'T18',
    releaseDate: '2026-09-19',
    status: 'NOW_SHOWING',
    genres: ['kinh-di'],
  },
  {
    slug: 'chu-meo-va-ngon-hai-dang',
    title: 'Chú Mèo Và Ngọn Hải Đăng',
    duration: 95,
    ageRating: 'P',
    releaseDate: '2026-11-14',
    status: 'COMING_SOON',
    genres: ['hoat-hinh', 'gia-dinh'],
  },
];

export const ROOM = { name: 'Phòng 1', rows: 10, cols: 12 } as const;

export interface SeatSpec {
  row: string;
  number: number;
  type: SeatType;
  coupleGroup: number | null;
}

/**
 * Layout of a rows×cols room:
 * - last row: couple seats, adjacent pairs share a coupleGroup (1, 2, 3...)
 * - rows 5–8 (E–H): VIP in the centre, STANDARD on the two outer seats of each side
 * - everything else: STANDARD
 */
export function buildRoomLayout(rows: number, cols: number): SeatSpec[] {
  if (rows < 9 || cols < 6 || cols % 2 !== 0) {
    throw new RangeError('Layout needs at least 9 rows and an even number (>= 6) of columns');
  }
  const seats: SeatSpec[] = [];
  for (let r = 0; r < rows; r++) {
    const row = String.fromCharCode('A'.charCodeAt(0) + r);
    const isCoupleRow = r === rows - 1;
    const isVipRow = r >= 4 && r <= 7;
    for (let number = 1; number <= cols; number++) {
      if (isCoupleRow) {
        seats.push({ row, number, type: 'COUPLE', coupleGroup: Math.ceil(number / 2) });
      } else {
        const isCentre = number > 2 && number <= cols - 2;
        seats.push({
          row,
          number,
          type: isVipRow && isCentre ? 'VIP' : 'STANDARD',
          coupleGroup: null,
        });
      }
    }
  }
  return seats;
}
