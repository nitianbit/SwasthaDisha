import { Service } from 'typedi';
import { CONFIG } from '@/config/config';

@Service()
export class ConfigService {
  get<T extends keyof typeof CONFIG>(key: T): (typeof CONFIG)[T] {
    return CONFIG[key];
  }
}
