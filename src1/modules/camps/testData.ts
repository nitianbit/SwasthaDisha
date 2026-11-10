import { ICamp, ICampDetails, ICampSlot } from '@/modules/camps/types';

export const sampleCamps: ICamp[] = [
  {
    campLsId: 'CMP_TEST_001',
    corporateName: 'EWA Sample Corporate',
    dates: ['2026-06-15', '2026-06-16'],
    numOrders: 12,
    labName: 'LabStack Sample Lab - Bengaluru',
    labLogo: null,
    lsLabId: 1001,
    lsChainId: 501,
    campStatus: 'SCHEDULED',
  },
  {
    campLsId: 'CMP_TEST_002',
    corporateName: 'Logicfirst Demo Corporate',
    dates: ['2026-06-20'],
    numOrders: 4,
    labName: 'LabStack Sample Lab - Mumbai',
    labLogo: null,
    lsLabId: 1002,
    lsChainId: null,
    campStatus: 'IN_PROGRESS',
  },
];

export const sampleCampDetails: Record<string, ICampDetails> = {
  CMP_TEST_001: {
    ...sampleCamps[0],
    orders: ['ORD_TEST_1001', 'ORD_TEST_1002', 'ORD_TEST_1003'],
    address: 'EWA Sample Tech Park, Tower 2, Outer Ring Road',
    locality: 'Marathahalli',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560037',
    phlebos: [
      {
        name: 'Sample Phlebo One',
        mobile: '9876543210',
        altMobile: null,
        email: null,
      },
    ],
    labCoordinators: [
      {
        name: 'Sample Coordinator',
        mobile: '9876543211',
        altMobile: null,
        email: 'coordinator@example.com',
      },
    ],
    labEscalators: [
      {
        name: 'Sample Escalation',
        mobile: '9876543212',
        altMobile: null,
        email: 'escalation@example.com',
      },
    ],
    notes: 'Temporary sample camp for frontend testing.',
  },
  CMP_TEST_002: {
    ...sampleCamps[1],
    orders: ['ORD_TEST_2001'],
    address: 'Demo Corporate Office, Andheri East',
    locality: 'Andheri',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400069',
    phlebos: [
      {
        name: 'Sample Phlebo Two',
        mobile: '9876543220',
        altMobile: null,
        email: null,
      },
    ],
    labCoordinators: [],
    labEscalators: [],
    notes: 'Temporary sample camp for frontend testing.',
  },
};

export const sampleCampSlots: Record<string, ICampSlot[]> = {
  CMP_TEST_001: [
    { date: '2026-06-15', time: '09:00' },
    { date: '2026-06-15', time: '09:30' },
    { date: '2026-06-16', time: '10:00' },
  ],
  CMP_TEST_002: [
    { date: '2026-06-20', time: '08:30' },
    { date: '2026-06-20', time: '09:00' },
  ],
};
