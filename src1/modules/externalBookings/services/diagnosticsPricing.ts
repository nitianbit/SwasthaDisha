import { AppError } from '@/modules/common/types';
import {
  ExternalCatalogIntegration,
  ExternalCatalogItemType,
  IExternalCatalogItem,
} from '@/modules/externalCatalogItems/types';

type DiagnosticsPricingService = {
  getPackageById: (
    packageId: string
  ) => Promise<{ packageItem?: Record<string, unknown> }>;
  getTestById: (testId: string) => Promise<{ testItem?: Record<string, unknown> }>;
  getPackagePriceById?: (
    packageId: string,
    input?: DiagnosticsPricingLocationInput
  ) => Promise<number | undefined>;
  getTestPriceById?: (
    testId: string,
    input?: DiagnosticsPricingLocationInput
  ) => Promise<number | undefined>;
};

type DiagnosticsPricingLocationInput = {
  pincode?: string;
  latitude?: number;
  longitude?: number;
};

type DiagnosticsCatalogRepository = {
  findByExternalId: (
    integration: ExternalCatalogIntegration,
    itemType: ExternalCatalogItemType,
    externalItemId: string
  ) => Promise<IExternalCatalogItem | null>;
};

function getFirstNumber(
  source: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && !Number.isNaN(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function priceFromPackageRaw(item: Record<string, unknown>): number | undefined {
  return getFirstNumber(item, [
    'price',
    'mrp',
    'offerPrice',
    'discountedPrice',
    'amount',
  ]);
}

function priceFromTestRaw(item: Record<string, unknown>): number | undefined {
  return getFirstNumber(item, [
    'minMrp',
    'price',
    'mrp',
    'offerPrice',
    'discountedPrice',
    'amount',
  ]);
}

function matchesLabId(
  source: Record<string, unknown>,
  labId: string
): boolean {
  const normalizedLabId = labId.trim();
  if (!normalizedLabId) {
    return false;
  }

  return ['labId', 'lsLabId', 'providerId', 'externalProviderId', 'id'].some(
    (key) => {
      const value = source[key];
      return value !== undefined && value !== null && String(value).trim() === normalizedLabId;
    }
  );
}

function findLabwisePrice(
  value: unknown,
  labId?: string
): number | undefined {
  const normalizedLabId = labId?.trim();
  if (!normalizedLabId || !value || typeof value !== 'object') {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const price = findLabwisePrice(item, normalizedLabId);
      if (price !== undefined) {
        return price;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (matchesLabId(record, normalizedLabId)) {
    const directPrice = getFirstNumber(record, [
      'offerPrice',
      'discountedPrice',
      'price',
      'mrp',
      'minMrp',
      'amount',
    ]);
    if (directPrice !== undefined) {
      return directPrice;
    }
  }

  for (const nested of Object.values(record)) {
    const nestedPrice = findLabwisePrice(nested, normalizedLabId);
    if (nestedPrice !== undefined) {
      return nestedPrice;
    }
  }

  return undefined;
}

async function getOverriddenDiagnosticsPrice(
  catalogRepository: DiagnosticsCatalogRepository,
  integration: ExternalCatalogIntegration,
  itemType: ExternalCatalogItemType,
  itemId: string,
  originalPrice: number
): Promise<number> {
  const metadata = await catalogRepository.findByExternalId(
    integration,
    itemType,
    itemId
  );

  if (typeof metadata?.customPrice === 'number' && metadata.customPrice > 0) {
    return metadata.customPrice;
  }

  return originalPrice;
}

/**
 * Sum LabStack package `price` / test `minMrp` (and fallbacks) for the given ids.
 * Missing or failed lookups contribute 0.
 */
export async function computeDiagnosticsOrderAmount(
  providerService: DiagnosticsPricingService,
  catalogRepository: DiagnosticsCatalogRepository,
  integration: ExternalCatalogIntegration,
  labId?: string,
  packageIds?: string[],
  testIds?: string[],
  locationInput: DiagnosticsPricingLocationInput = {}
): Promise<number> {
  const pkgIds = [ 
    ...new Set((packageIds || []).map((id) => id.trim()).filter(Boolean)),
  ];
  const tstIds = [
    ...new Set((testIds || []).map((id) => id.trim()).filter(Boolean)),
  ];

  if (pkgIds.length === 0 && tstIds.length === 0) {
    return 0;
  }

  const packageParts = await Promise.all(
    pkgIds.map(async (id) => {
      try {
        if (providerService.getPackagePriceById) {
          const price = await providerService.getPackagePriceById(
            id,
            locationInput
          );
          if (price !== undefined && price > 0) {
            return getOverriddenDiagnosticsPrice(
              catalogRepository,
              integration,
              'package',
              id,
              price
            );
          }
        }
        const { packageItem } = await providerService.getPackageById(id);
        if (
          packageItem &&
          typeof packageItem === 'object' &&
          !Array.isArray(packageItem)
        ) {
          const raw = packageItem as Record<string, unknown>;
          const resolvedPrice =
            findLabwisePrice(raw, labId) ??
            priceFromPackageRaw(raw);
          if (resolvedPrice !== undefined && resolvedPrice > 0) {
            return getOverriddenDiagnosticsPrice(
              catalogRepository,
              integration,
              'package',
              id,
              resolvedPrice
            );
          }
        }
      } catch {
        /* ignore */
      }
      throw new AppError({
        status: 500,
        code: 'DIAGNOSTICS_PACKAGE_PRICE_UNAVAILABLE',
        message: `Unable to determine package price for ${id}`,
      });
    })
  );

  const testParts = await Promise.all(
    tstIds.map(async (id) => {
      try {
        if (providerService.getTestPriceById) {
          const price = await providerService.getTestPriceById(
            id,
            locationInput
          );
          if (price !== undefined && price > 0) {
            return getOverriddenDiagnosticsPrice(
              catalogRepository,
              integration,
              'test',
              id,
              price
            );
          }
        }
        const { testItem } = await providerService.getTestById(id);
        if (testItem && typeof testItem === 'object' && !Array.isArray(testItem)) {
          const raw = testItem as Record<string, unknown>;
          const resolvedPrice =
            findLabwisePrice(raw, labId) ??
            priceFromTestRaw(raw);
          if (resolvedPrice !== undefined && resolvedPrice > 0) {
            return getOverriddenDiagnosticsPrice(
              catalogRepository,
              integration,
              'test',
              id,
              resolvedPrice
            );
          }
        }
      } catch {
        /* ignore */
      }
      throw new AppError({
        status: 500,
        code: 'DIAGNOSTICS_TEST_PRICE_UNAVAILABLE',
        message: `Unable to determine test price for ${id}`,
      });
    })
  );

  const sum = [...packageParts, ...testParts].reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    throw new AppError({
      status: 500,
      code: 'DIAGNOSTICS_PRICE_UNAVAILABLE',
      message: 'Price of package or test cannot be zero',
    });
  }
  return Math.round(sum * 100) / 100;
}

export function toDiagnosticsAppointmentIso(
  yyyymmdd: string,
  time: string
): string {
  const date = /^\d{8}$/.test(yyyymmdd)
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : yyyymmdd;

  const normalized = time.trim();
  const hhmmMatch = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (hhmmMatch) {
    const hh = String(
      Math.min(23, Math.max(0, Number(hhmmMatch[1])))
    ).padStart(2, '0');
    const mm = String(
      Math.min(59, Math.max(0, Number(hhmmMatch[2])))
    ).padStart(2, '0');
    return `${date}T${hh}:${mm}:00.000`;
  }

  const ampmMatch = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(normalized);
  if (ampmMatch) {
    let hh = Number(ampmMatch[1]);
    const mm = String(
      Math.min(59, Math.max(0, Number(ampmMatch[2])))
    ).padStart(2, '0');
    const isPm = ampmMatch[3].toUpperCase() === 'PM';
    if (isPm && hh !== 12) {
      hh += 12;
    }
    if (!isPm && hh === 12) {
      hh = 0;
    }
    return `${date}T${String(hh).padStart(2, '0')}:${mm}:00.000`;
  }

  return `${date}T00:00:00.000`;
}
