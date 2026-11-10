# TypeScript Setup Guide

This project uses TypeScript for the `src1` directory with Typedi for dependency injection.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Build TypeScript:
```bash
npx tsc
```

3. Run with ts-node-dev (for development):
```bash
npm run dev:ts
```

## Project Structure

- `src1/` - TypeScript source code
  - `modules/` - Feature modules
    - `common/` - Shared utilities, types, and base classes
      - `types/` - Common TypeScript interfaces and types
      - `repository/` - BaseRepository class
      - `utils/` - Utility functions (catchAsync, wrapAsync)
    - `middleware/` - Express middleware (errorHandler)
    - `auth/` - Authentication module (example)
  - `services/` - Shared services (logger)
  - `config/` - Configuration files (Typedi container)

## Import Paths

All imports use the `@` alias which maps to `src1/`:

```typescript
// Instead of relative paths like:
import { AppError } from '../../common/types';

// Use @ alias:
import { AppError } from '@/modules/common/types';
import logger from '@/services/logger';
import { AuthService } from '@/modules/auth/services';
```

## Using Typedi

### Services and Repositories

All services and repositories should be decorated with `@Service()`:

```typescript
import { Service } from 'typedi';
import { BaseRepository } from '@/modules/common/repository';
import MyModel from '@/modules/myModule/model';
import { IMyType } from '@/modules/myModule/types';

@Service()
export class MyRepository extends BaseRepository<IMyType> {
  constructor() {
    super(MyModel);
  }
}

@Service()
export class MyService {
  constructor(private myRepository: MyRepository) {}
}
```

### Controllers

Controllers are NOT injectable. They should get services from the Typedi container:

```typescript
import 'reflect-metadata';
import { Container } from 'typedi';
import { MyService } from '@/modules/myModule/services';

export class MyController {
  private myService: MyService;

  constructor() {
    this.myService = Container.get(MyService);
  }

  myMethod = async (req: Request, res: Response, next: NextFunction) => {
    // Implementation using this.myService
  };
}
```

### Routes

In routes, instantiate controllers directly (not from container):

```typescript
import 'reflect-metadata';
import { Router } from 'express';
import { MyController } from '@/modules/myModule/controller';
import { catchAsync } from '@/modules/common/utils/asyncHandler';

const router = Router();
const myController = new MyController();

router.post('/endpoint', catchAsync(myController.myMethod));
```

## Error Handling

Use `AppError` for custom errors:

```typescript
import { AppError } from '@/modules/common/types';

throw new AppError({
  status: 404,
  code: 'NOT_FOUND',
  message: 'Resource not found',
});
```

Use `catchAsync` for controller methods and `wrapAsync` for regular functions.

## BaseRepository

All repositories should extend `BaseRepository`:

```typescript
import { Service } from 'typedi';
import { BaseRepository } from '@/modules/common/repository';
import MyModel from '@/modules/myModule/model';
import { IMyType } from '@/modules/myModule/types';

@Service()
export class MyRepository extends BaseRepository<IMyType> {
  constructor() {
    super(MyModel);
  }

  // Add custom methods here
  async findByCustomField(field: string) {
    return this.findOne({ customField: field });
  }
}
```
