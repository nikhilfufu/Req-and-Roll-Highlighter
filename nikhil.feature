# ============================================================
#  ShoppingCart.feature
#  Sample BDD feature file for SpecFlow / Reqnroll
#  Covers: basic scenarios, scenario outline, background,
#          data tables, doc strings, and tags
# ============================================================

@shopping @regression
Feature: Shopping Cart
  As a registered customer
  I want to manage items in my shopping cart
  So that I can purchase products easily


  # ── Background ──────────────────────────────────────────────
  # Runs before every scenario in this feature file

  Background:
    Given the user "john.doe@example.com" is logged in
    And the product catalogue is loaded


  # ── Simple Scenario ─────────────────────────────────────────

  @smoke
  Scenario: Add a single item to the cart
    Given the cart is empty
    When the user adds "Wireless Mouse" to the cart
    Then the cart should contain 1 item
    And the cart total should be 29.99


  # ── Multiple Steps with Parameters ──────────────────────────

  Scenario: Remove an item from the cart
    Given the cart contains the following items
      | Product         | Quantity | Unit Price |
      | Wireless Mouse  | 1        | 29.99      |
      | Mechanical Keyboard | 1    | 89.99      |
    When the user removes "Wireless Mouse" from the cart
    Then the cart should contain 1 item
    And the cart total should be 89.99


  # ── Scenario Outline (Data-Driven) ──────────────────────────

  @smoke @data-driven
  Scenario Outline: Apply discount coupon
    Given the cart total is <initialTotal>
    When the user applies coupon code "<couponCode>"
    Then the discount of <discountPercent>% should be applied
    And the final cart total should be <finalTotal>

    Examples:
      | initialTotal | couponCode  | discountPercent | finalTotal |
      | 100.00       | SAVE10      | 10              | 90.00      |
      | 200.00       | SAVE20      | 20              | 160.00     |
      | 50.00        | HALFOFF     | 50              | 25.00      |
      | 75.00        | INVALIDCODE | 0               | 75.00      |


  # ── Scenario with Doc String ─────────────────────────────────

  Scenario: Display order confirmation message
    Given the user has checked out with the following address
      """
      John Doe
      123 Main Street
      Bangalore, Karnataka 560001
      India
      """
    When the order is placed successfully
    Then the confirmation message should contain "Thank you for your order"
    And a confirmation email should be sent to "john.doe@example.com"


  # ── Edge Cases ───────────────────────────────────────────────

  @negative
  Scenario: Add out-of-stock item to the cart
    Given the product "Limited Edition Headphones" is out of stock
    When the user tries to add "Limited Edition Headphones" to the cart
    Then an error message "Item is currently out of stock" should be displayed
    And the cart should remain empty

  @negative
  Scenario: Apply expired coupon
    Given the cart total is 100.00
    When the user applies coupon code "EXPIRED2023"
    Then an error message "Coupon has expired" should be displayed
    And the cart total should remain 100.00


  # ── Multi-Step Workflow ──────────────────────────────────────

  @end-to-end
  Scenario: Complete purchase workflow
    Given the cart is empty
    And the user has a saved payment method "Visa ending in 4242"
    When the user adds 3 units of "USB-C Hub" at 19.99 each to the cart
    And the user proceeds to checkout
    And the user selects the saved payment method
    And the user confirms the order
    Then the order status should be "Confirmed"
    And the inventory for "USB-C Hub" should decrease by 3
    And a receipt should be generated with total 59.97
