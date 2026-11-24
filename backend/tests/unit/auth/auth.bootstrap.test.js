import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import bcrypt from 'bcryptjs';

// Mock logger
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }
}));

// In-memory mock database for User model
let mockUsers = [];

class MockUser {
  constructor(data) {
    Object.assign(this, data);
  }

  static findOne(query) {
    const execute = async () => {
      let found = mockUsers.find(u => {
        if (query.email) {
          if (query.email.$ne) {
            return u.email !== query.email.$ne;
          }
          return u.email.toLowerCase() === query.email.toLowerCase();
        }
        if (query.role) {
          if (query._id && query._id.$ne) {
            return u.role === query.role && u._id !== query._id.$ne;
          }
          return u.role === query.role;
        }
        return false;
      });

      if (!found) return null;

      return {
        ...found,
        comparePassword: async function(candidate) {
          if (!this.password || !candidate) return false;
          return bcrypt.compare(candidate, this.password);
        },
        save: async function() {
          const idx = mockUsers.findIndex(u => u._id === this._id);
          if (idx >= 0) mockUsers[idx] = { ...this };
          return this;
        },
        toJSON: function() {
          const copy = { ...this, id: this._id };
          delete copy.password;
          return copy;
        }
      };
    };

    const queryObj = {
      select: function(fields) {
        return queryObj;
      },
      then: function(resolve, reject) {
        return execute().then(resolve, reject);
      },
      catch: function(reject) {
        return execute().catch(reject);
      }
    };

    return queryObj;
  }

  static async updateOne(query, update, options = {}) {
    let idx = mockUsers.findIndex(u => {
      if (query.email) return u.email.toLowerCase() === query.email.toLowerCase();
      if (query._id) return u._id === query._id;
      return false;
    });

    const setValues = update.$set || update;
    if (idx >= 0) {
      mockUsers[idx] = { ...mockUsers[idx], ...setValues };
    } else if (options.upsert) {
      const newUser = {
        _id: 'mock_id_' + Date.now(),
        ...query,
        ...setValues
      };
      mockUsers.push(newUser);
    }
    return { acknowledged: true, modifiedCount: idx >= 0 ? 1 : 0 };
  }

  static async updateMany(query, update) {
    let count = 0;
    mockUsers.forEach((u, i) => {
      if (query.role && u.role === query.role) {
        if (!query.email || (query.email.$ne && u.email !== query.email.$ne)) {
          mockUsers[i] = { ...u, ...(update.$set || update) };
          count++;
        }
      }
    });
    return { acknowledged: true, modifiedCount: count };
  }
}

jest.unstable_mockModule('../../../src/users/user.model.js', () => ({
  default: MockUser
}));

const { authenticateUser } = await import('../../../src/auth/auth.service.js');
const { bootstrapDefaultAdmin } = await import('../../../src/users/user.service.js');

describe('Admin Bootstrap and Authentication', () => {
  beforeEach(() => {
    mockUsers = [];
    jest.clearAllMocks();
  });

  test('bootstrapDefaultAdmin creates admin user with bcrypt hashed password', async () => {
    await bootstrapDefaultAdmin();

    expect(mockUsers.length).toBe(1);
    const admin = mockUsers[0];
    expect(admin.email).toBe('sankalpgaonkar23@gmail.com');
    expect(admin.role).toBe('admin');
    expect(admin.isActive).toBe(true);
    expect(admin.operativeId).toBe('ADMIN_1');

    const isMatch = await bcrypt.compare('Admin@123', admin.password);
    expect(isMatch).toBe(true);
  });

  test('authenticateUser automatically bootstraps and logs in admin when account is not yet created', async () => {
    expect(mockUsers.length).toBe(0);

    const result = await authenticateUser('sankalpgaonkar23@gmail.com', 'Admin@123');

    expect(result.token).toBeDefined();
    expect(result.user.email).toBe('sankalpgaonkar23@gmail.com');
    expect(result.user.role).toBe('admin');
  });

  test('authenticateUser repairs password if admin exists with missing password (e.g. from Google OAuth)', async () => {
    mockUsers.push({
      _id: 'existing_admin_id',
      email: 'sankalpgaonkar23@gmail.com',
      role: 'admin',
      operativeId: 'ADMIN_1',
      isActive: true,
      authProvider: 'google',
      password: null,
    });

    const result = await authenticateUser('sankalpgaonkar23@gmail.com', 'Admin@123');

    expect(result.token).toBeDefined();
    expect(result.user.email).toBe('sankalpgaonkar23@gmail.com');
    expect(result.user.role).toBe('admin');
    expect(mockUsers[0].password).toBeDefined();
  });

  test('authenticateUser rejects incorrect password for admin', async () => {
    await bootstrapDefaultAdmin();

    await expect(authenticateUser('sankalpgaonkar23@gmail.com', 'WrongPassword!'))
      .rejects.toThrow('Invalid credentials');
  });
});
