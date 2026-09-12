import React from 'react';
import {
  Image as ImageIcon,
  Users,
  MapPin,
  BookImage,
  Settings
} from 'lucide-react';
import { ActiveTab } from './Sidebar';

interface MobileBottomNavProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  activeTab,
  onSelectTab,
}) => {
  const tabs = [
    { id: 'photos' as ActiveTab, label: 'Photos', icon: ImageIcon },
    { id: 'people' as ActiveTab, label: 'People', icon: Users },
    { id: 'places' as ActiveTab, label: 'Places', icon: MapPin },
    { id: 'albums' as ActiveTab, label: 'Albums', icon: BookImage },
    { id: 'settings' as ActiveTab, label: 'Settings', icon: Settings },
  ];

  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: '62px',
        backgroundColor: 'rgba(15, 23, 42, 0.94)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        zIndex: 100,
        paddingBottom: 'env(safe-area-inset-bottom, 4px)',
      }}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              flex: 1,
              height: '100%',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: isActive ? 'var(--accent-cyan)' : 'var(--text-muted)',
              transition: 'all 0.15s ease-out',
              padding: '4px 0',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <div
              style={{
                width: '36px',
                height: '24px',
                borderRadius: '12px',
                backgroundColor: isActive ? 'rgba(6, 182, 212, 0.15)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.15s ease-out',
              }}
            >
              <Icon size={19} strokeWidth={isActive ? 2.3 : 1.8} />
            </div>
            <span
              style={{
                fontSize: '0.68rem',
                fontWeight: isActive ? 600 : 500,
                letterSpacing: '0.01em',
              }}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
};
